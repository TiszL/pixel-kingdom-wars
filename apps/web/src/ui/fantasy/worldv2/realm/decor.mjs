// Realm maps — level decor of a claimed deed (plan §6.3, §6.7). BASES lane.
//
// composeBaseDecor() is PURE and DETERMINISTIC: the same (level, realm, seed) always yields the same
// kingdom. It is the one source of every decor instance, used three ways, which is why it must be pure:
//   1. TRUE band: bases.js draws each instance as its true sprite;
//   2. MAP band (d ≥ 200): bases.js draws each instance as a reduced "mini-sprite" at THE SAME seat,
//      so over d 800→1100 it dissolves to its true sprite in place (plan §2.3, §6.2);
//   3. PACK step 7 (art-prep/realm/base-atlas.mjs) renders the formation-0 yard layer (turf + walls)
//      from it offline into plots.webp.
// Coordinates are deed-local tiles (0…98; the plot centre is PLOT_CENTRE = 49). A sprite instance is
// seated like the base scene seats it (apps/web v2/clips.ts buildingSeatY, owner 2026-08-30): the
// anchor column sits on the footprint's centre, the CELL BOTTOM on the footprint's south edge, and the
// depth key is that south edge. So `tx,ty` is where cell point `anchor` lands and `scale` is tiles per
// source px (sourceScale / 32).
//
// Why the decor is illustrative, never the real layout: real defence composition is scout information
// and scouting is metered (plan §6.3). The card says "Illustration of a level-L kingdom".
import {
  plotRule, plotOffset, KEEP_FIT, KEEP_FOOTPRINT, PLOT_CENTRE, TILES, ART, decorCap, towerTier, wallCapForKeepLevel,
} from './contracts.mjs';
import {
  STRUCTURES, DEFENSES, WARE_WORLD_PRESENTATION, ART_V2, MINING, CAMPAIGN_LAYOUT, BUILD_COUNT_CAP_BY_KEEP,
} from '@shardkeep/shared';
import { wallShape } from '@shardkeep/shared';

// ---- presentation numbers owned by this module (move to a REALM_MAP block in constants.ts at
// productisation, plan §6.3 last paragraph) ------------------------------------------------------
export const DECOR_LAYOUT = Object.freeze({
  /** Hero altar / siege stool are legacy 64×80 sprites drawn at 1 in game, i.e. 2.16 t tall: taller
   *  than the Keep at L1–L13, which breaks the owner's sky law (constants BUILDING_FIT: "nothing
   *  reaches it"). The decor draws them at 0.75 (1.62 t) so the law holds from their L3 unlock. */
  heroScale: 0.75,
  /** Thin poles (banners, lamp posts, brazier posts) carry no mass; they may reach 1.15× the Keep's ink
   *  height (the Keep's own overhang ratio, BUILDING_FIT.maxPlotOverhang) but never its ink area. */
  poleSky: 1.15,
  /** The tended ring's ladder (fix iteration 1): fields take per-seed slots of the ring (ringSlots/ringWants), so
   *  they widen with the ring (4 t at L1 → 9 t at L20; plan §6.3 "widest fields and orchard ring" at L17–20) but
   *  never sit on the same four corners; the unlock levels below say when each tended patch joins the base. */
  hayFrom: 1, wellFrom: 3, hiveFrom: 4, penFrom: 6, orchardFrom: 10, orchard2From: 17, farmFrom: 12, farm2From: 17,
  tentFrom: 1, smokeByBand: Object.freeze([0, 0, 1, 2, 2, 3]), // index = decorBand(L)
  /** Pen footprint (w×h tiles): two fence rows with a gate, two head of the realm's livestock. */
  pen: Object.freeze([4, 3]),
  /** The tended ring (round 2, T3): hedges round fields from L8 (60 %), round every field from L13; a field prop
   *  (scarecrow, sluice, barrow) from L3; wild scatter density per free ring cell = base + edge·outerness (+ segment
   *  when the whole segment is wild), so the plot thickens into LIFE's wilderness at its edge. */
  hedgeFrom: 8, hedgeAllFrom: 13, fieldPropFrom: 3,
  wild: Object.freeze({ base: 0.05, edge: 0.3, segment: 0.16 }),
  /** Share of bed slots left fallow (bare furrowed soil), so a field never reads as a solid block of one sprite. */
  fallow: 0.16,
  /** Sister varieties a bed switches to now and then (a field ripening unevenly). */
  cropPairs: Object.freeze({ wheat_ripe: 'wheat_young', wheat_young: 'wheat_ripe', oat_rig: 'oat_rig_b', oat_rig_b: 'oat_rig', kale_bed: 'lazybed', lazybed: 'kale_bed',
    mushroom_cluster_ember: 'mushroom_log_ember', millet_bed: 'melon_patch',
    // ART beds: a field part-harvested (stubble) or ripening unevenly (young / ripe of one grain); used only where the realm has both
    crop_winter_rye: 'crop_hay_stubble', crop_frost_barley: 'crop_barley_young', crop_oats: 'crop_hay_stubble', crop_bere_barley: 'crop_hay_stubble',
    crop_barley: 'crop_wheat_young', crop_ember_grain: 'crop_millet',
    // Stage B realms: a paddy of young rice with its thinner row, ripe rice beside tall; herb and crystal beds alternate
    rice_young_ew: 'rice_young_ew_b', rice_young_ew_b: 'rice_young_ew', rice_ripe_ew: 'rice_tall_ew', herb_bed_ew: 'herb_bed_c',
    crystal_bed_ew: 'crystal_bed_b', crystal_bed_b: 'crystal_bed_ew' }),
  /** Ground under the tended land, per realm (hex): tilled field soil, trampled pen / camp earth, the lane road.
   *  Picked from each kit's own ground swatches (realm.json palette.kit.ground / road), darkened for soil. */
  soil: Object.freeze({
    sunscar: Object.freeze({ field: '#8e5a2e', pen: '#b08a5a', path: '#ad8c58' }),
    frostveil: Object.freeze({ field: '#8e8782', pen: '#b4bec4', path: '#a1adb4' }),
    cinderfall: Object.freeze({ field: '#3f3029', pen: '#5e5146', path: '#4a4346' }),
    crownlands: Object.freeze({ field: '#6e4a2c', pen: '#8f7a55', path: '#8b7a5e' }),
    stormcairn: Object.freeze({ field: '#4f4439', pen: '#6d6a52', path: '#727564' }),
    // Stage B (kit swatches in each pack's palette.kit.ground): Elderwood loam, Thornwake paddy mud, Solana Reach's
    // crystaldust darkened for tilled soil; the path is the kit's worn track (Solana: crystaldust, not the obsidian road)
    elderwood: Object.freeze({ field: '#5a4832', pen: '#7a6a4c', path: '#676e54' }),
    thornwake: Object.freeze({ field: '#56402d', pen: '#7a6247', path: '#6c6c51' }),
    'seeker-reach': Object.freeze({ field: '#5f5a7e', pen: '#7a7596', path: '#9088b3' }),
  }),
  /** Terrain of the lanes and the paths between kingdoms when it is not the realm's ROAD terrain (Stage B): Solana
   *  Reach's kit keeps its obsidian road for the main ways and joins its yards with crystaldust worn tracks (kit
   *  165886cf, "BRIEF gives crystaldust the garden paths"), so its kingdoms' lanes and paths are crystaldust too. */
  track: Object.freeze({ 'seeker-reach': 'crystaldust' }),
  /** Torch glow disc (art px radius, alpha) and flicker (plan §6.4). */
  glow: Object.freeze({ r: 10, a: 0.25, flicker: 0.05 }),
});

// ---- measured art geometry (read-only masters; scratch measure.mjs, 2026-09-24) --------------------
// GAME_ART key → [cellW, cellH, anchorX, inkX0, inkY0, inkX1, inkY1, frames, fps, rows] (frame 0, row 0 = 's')
// Sources: art/game-v4/buildings/<fam>/<t|l>/idle.png, <fam>/base.png; geometry from art/game-v4/target-ledger.json.
const GAME_ART = {
  'archer/t1':[64,96,32,6,30,44,86,3,12,8], 'archer/t2':[64,96,32,5,23,47,86,3,12,8], 'archer/t3':[64,96,32,4,18,50,86,3,12,8], 'archer/t4':[64,96,32,3,8,53,86,3,12,8],
  'cannon/t1':[112,120,56,26,34,87,114,2,3,8], 'cannon/t2':[112,120,56,23,28,89,115,2,3,8], 'cannon/t3':[112,120,56,21,22,92,116,2,3,8], 'cannon/t4':[112,120,56,19,17,94,117,2,3,8],
  'mortar/t1':[112,120,56,23,50,90,102,2,3,8], 'mortar/t2':[112,120,56,23,45,90,102,2,3,8], 'mortar/t3':[112,120,56,23,40,90,102,2,3,8], 'mortar/t4':[112,120,56,23,40,90,102,2,3,8],
  'airdefence/t1':[112,120,56,15,70,88,111,2,10,8], 'airdefence/t2':[112,120,56,9,64,89,112,2,10,8], 'airdefence/t3':[112,120,56,6,59,93,113,2,10,8], 'airdefence/t4':[112,120,56,1,53,96,114,2,10,8],
  'electrictower/t1':[64,96,32,10,22,54,87,3,12,1], 'electrictower/t2':[64,96,32,10,15,54,87,3,12,1], 'electrictower/t3':[64,96,32,10,9,54,87,3,12,1], 'electrictower/t4':[64,96,32,10,1,54,87,3,12,1],
  'magetower/t1':[64,96,32,19,31,46,86,4,12,1], 'magetower/t2':[64,96,32,18,25,47,87,4,12,1], 'magetower/t3':[64,96,32,17,18,48,87,4,12,1], 'magetower/t4':[64,96,32,17,12,48,87,4,12,1],
  'lasertower/t1':[64,96,32,3,29,61,87,2,12,8], 'lasertower/t2':[64,96,32,3,17,61,87,2,12,8], 'lasertower/t3':[64,96,32,3,4,61,87,2,12,8], 'lasertower/t4':[64,96,32,3,2,61,87,2,12,8],
  'dragonnest/t1':[112,96,56,21,45,90,91,4,12,1], 'dragonnest/t2':[112,96,56,15,30,94,91,4,12,1], 'dragonnest/t3':[112,96,56,11,18,98,91,4,12,1], 'dragonnest/t4':[112,96,56,5,7,104,91,4,12,1],
  'vault/t1':[64,80,32,4,27,59,75,2,8,1], 'vault/t2':[64,80,32,4,20,60,75,2,8,1], 'vault/t3':[64,80,32,1,17,63,75,2,8,1], 'vault/t4':[64,80,32,1,16,63,75,2,8,1],
  'mine/t1':[96,88,48,12,28,78,84,3,12,1], 'mine/t2':[96,88,48,13,23,77,84,3,12,1], 'mine/t3':[96,88,48,12,16,79,85,3,12,1], 'mine/t4':[96,88,48,11,10,78,84,3,12,1],
  'barracks/t1':[96,88,48,11,27,86,87,2,8,1], 'barracks/t2':[96,88,48,7,26,89,87,2,8,1], 'barracks/t3':[96,88,48,4,24,92,87,2,8,1], 'barracks/t4':[96,88,48,2,21,94,87,2,8,1],
  'camp/t1':[104,96,52,31,66,74,94,4,8,1], 'camp/t2':[104,96,52,29,60,76,94,4,8,1], 'camp/t3':[104,96,52,27,51,78,94,4,8,1], 'camp/t4':[104,96,52,24,49,80,94,4,8,1],
  'clanhall/t1':[112,104,56,29,39,83,95,4,12,1], 'clanhall/t2':[112,104,56,23,7,89,95,4,12,1], 'clanhall/t3':[112,104,56,17,7,97,95,4,12,1], 'clanhall/t4':[112,104,56,7,7,101,95,4,12,1],
  'alchemylab/t1':[72,96,36,11,29,62,81,2,8,1], 'alchemylab/t2':[72,96,36,8,21,65,81,2,8,1], 'alchemylab/t3':[72,96,36,6,18,68,81,2,8,1], 'alchemylab/t4':[72,96,36,7,8,71,81,2,8,1],
  'keep/l1':[144,136,72,31,39,112,125,3,12,1], 'keep/l2':[144,136,72,30,38,113,125,3,12,1], 'keep/l3':[144,136,72,29,38,115,125,3,12,1], 'keep/l4':[144,136,72,28,38,115,125,3,12,1],
  'keep/l5':[144,136,72,28,38,116,125,3,12,1], 'keep/l6':[144,136,72,27,38,117,125,3,12,1], 'keep/l7':[144,136,72,26,38,117,126,3,12,1], 'keep/l8':[144,136,72,26,35,117,126,3,12,1],
  'keep/l9':[144,136,72,25,32,118,126,3,12,1], 'keep/l10':[144,136,72,24,28,119,126,3,12,1], 'keep/l11':[144,136,72,23,26,120,126,3,12,1], 'keep/l12':[144,136,72,22,23,122,127,3,12,1],
  'keep/l13':[144,136,72,20,18,124,127,3,12,1], 'keep/l14':[144,136,72,19,16,125,128,3,12,1], 'keep/l15':[144,136,72,18,15,125,128,3,12,1], 'keep/l16':[144,136,72,17,13,126,128,3,12,1],
  'keep/l17':[144,136,72,16,11,127,128,3,12,1], 'keep/l18':[144,136,72,15,9,128,129,3,12,1], 'keep/l19':[144,136,72,14,8,129,129,3,12,1], 'keep/l20':[144,136,72,13,6,130,129,3,12,1],
  'goldforge/l1':[112,112,56,30,61,82,107,4,12,1], 'goldforge/l2':[112,112,56,29,60,82,107,4,12,1], 'goldforge/l3':[112,112,56,28,57,84,107,4,12,1], 'goldforge/l4':[112,112,56,27,55,84,107,4,12,1],
  'goldforge/l5':[112,112,56,25,53,86,107,4,12,1], 'goldforge/l6':[112,112,56,25,51,87,107,4,12,1], 'goldforge/l7':[112,112,56,23,49,88,107,4,12,1], 'goldforge/l8':[112,112,56,22,47,89,107,4,12,1],
  'goldforge/l9':[112,112,56,21,45,90,107,4,12,1], 'goldforge/l10':[112,112,56,20,42,91,107,4,12,1], 'goldforge/l11':[112,112,56,19,40,93,107,4,12,1], 'goldforge/l12':[112,112,56,18,38,94,107,4,12,1],
  'goldforge/l13':[112,112,56,17,36,95,107,4,12,1], 'goldforge/l14':[112,112,56,16,34,96,107,4,12,1], 'goldforge/l15':[112,112,56,14,32,97,107,4,12,1], 'goldforge/l16':[112,112,56,14,29,98,107,4,12,1],
  'goldforge/l17':[112,112,56,12,27,100,107,4,12,1], 'goldforge/l18':[112,112,56,11,25,100,107,4,12,1], 'goldforge/l19':[112,112,56,10,23,102,107,4,12,1], 'goldforge/l20':[112,112,56,9,21,102,107,4,12,1],
  'heroaltar/base':[64,80,32,0,0,64,69,1,0,1], 'siegestool/base':[64,80,32,2,11,62,72,1,0,1],
};
/** Keep spire tips (cell px, frame 0) per level 1…20: pennant seats (plan §6.4). Outermost two are the
 *  tall cone spires; the inner two are the central tower's corner turrets. */
export const KEEP_TIPS = [[[38,57],[56,39],[86,39],[105,57]],[[37,54],[56,38],[86,38],[105,54]],[[37,51],[57,38],[86,38],[106,51]],[[36,50],[57,38],[87,38],[107,49]],[[35,45],[56,38],[87,38],[107,45]],[[35,43],[56,38],[87,38],[107,43]],[[35,38],[55,38],[88,38],[108,39]],[[35,35],[56,39],[88,39],[108,35]],[[35,32],[55,39],[88,39],[108,33]],[[34,29],[55,39],[88,39],[107,28]],[[34,26],[55,40],[88,40],[107,26]],[[35,23],[55,41],[88,41],[107,23]],[[36,20],[56,44],[87,44],[107,18]],[[36,16],[57,46],[86,46],[106,16]],[[35,15],[55,43],[88,44],[107,15]],[[35,15],[54,40],[88,40],[108,13]],[[34,11],[54,39],[88,39],[108,11]],[[33,9],[54,38],[88,38],[109,9]],[[33,8],[53,36],[89,36],[109,8]],[[32,6],[53,35],[89,35],[110,6]]];
/** wall5 cell heights per tier (constants WALL_ART.sourceFrameHeights), 32 px wide, anchor [0.5, 1]. */
const WALL_CELL_H = [44, 48, 52, 56, 60];
/** legacy-fx_fire_f1..3: 16×24, anchor [0.5, 1], 3 frames at 110 ms (plan §6.4). */
const FIRE = { cell: [16, 24], ink: [2, 2, 15, 23], frames: 3, ms: 110 };

// KIT_ART realm → id → [cellW, cellH, inkX0, inkY0, inkX1, inkY1, fpW, fpH, frames, ms]; ink is SEATED
// (ink bottom on the cell bottom, as the kit builder seats props). Read at realm-kit fc5c6ad19ea6
// (C8 sign-off SHA; Stormcairn at the same SHA is 'unsynced'), only ids referenced by each kit.json.
// Creatures: frame 0 of the 'down' row (sheet = 4 facings × 6 frames of 64×64).
const KIT_ART = {
  crownlands: {
    bush:[64,64,11,25,54,64,1,1,1,0], berry_bush:[64,64,10,26,54,64,1,1,1,0], flowers:[64,64,8,31,57,64,1,1,1,0], rock_s:[64,64,13,42,49,64,1,1,1,0], dry_grass:[64,64,10,22,54,64,1,1,1,0], mushrooms:[64,64,13,35,52,64,1,1,1,0], stump:[64,64,11,29,53,64,1,1,1,0], canopy_sapling:[64,64,20,28,44,64,1,1,1,0], boulder_mossy:[64,64,8,24,56,64,2,1,1,0], rock_l:[64,64,10,28,54,64,1,1,1,0], log:[64,64,6,28,58,64,2,1,1,0], birch:[64,64,19,16,45,64,1,1,1,0], pine:[64,64,16,16,48,64,1,1,1,0], canopy_hawthorn:[64,64,1,15,63,64,1,1,1,0], scarecrow:[64,64,12,7,52,64,1,1,1,0], barrels:[64,64,9,12,54,64,1,1,1,0], crates:[64,64,6,13,59,64,1,1,1,0], grain_sacks:[64,64,8,21,57,64,1,1,1,0], log_pile:[64,64,7,20,56,64,2,1,1,0], chopping_block:[64,64,16,19,56,64,1,1,1,0],
    fence_ew:[64,64,3,34,61,64,2,1,1,0], fence_post:[64,64,22,23,42,64,1,1,1,0], well:[64,64,10,9,54,64,1,1,1,0],
    cart_hay:[64,64,3,18,58,64,2,1,1,0], trough:[64,64,7,27,57,64,2,1,1,0], hay_bale:[64,64,11,26,53,64,1,1,1,0],
    wheat_ripe:[64,64,3,16,61,64,2,2,1,0], wheat_young:[64,64,3,17,61,64,2,2,1,0], campfire:[64,64,13,30,51,64,1,1,9,110],
    lantern_post:[64,64,19,10,43,64,1,1,9,120], banner_pole:[64,64,22,6,54,64,1,1,9,120], tent:[64,64,4,15,64,64,2,2,1,0],
    beehive:[64,64,15,16,50,64,1,1,1,0], canopy_oak_young:[64,64,16,22,48,64,1,1,1,0], canopy_rowan:[64,64,9,7,55,64,1,1,1,0],
    'creature:sheep':[64,64,22,33,42,64,1,1,6,130], 'creature:pig':[64,64,22,28,42,64,1,1,6,130],
  },
  frostveil: {
    bush_snow:[64,64,6,18,58,64,1,1,1,0], frosted_shrub:[64,64,10,20,54,64,1,1,1,0], holly_snow:[64,64,9,25,56,64,1,1,1,0], rock_s_frost:[64,64,8,31,55,64,1,1,1,0], berry_bush_frost:[64,64,5,23,59,64,1,1,1,0], canopy_sapling_snow:[64,64,23,30,44,64,1,1,1,0], stump_snow:[64,64,8,23,56,64,1,1,1,0], canopy_juniper:[64,64,6,33,57,64,1,1,1,0], canopy_bramble_frost:[64,64,8,32,57,64,1,1,1,0], boulder_snow:[64,64,6,18,58,64,2,1,1,0], rock_l_frost:[64,64,9,26,55,64,1,1,1,0], snow_mound:[64,64,4,28,61,64,2,1,1,0], canopy_spruce:[64,64,13,4,50,64,1,1,1,0], canopy_fir_snow:[64,64,10,7,54,64,1,1,1,0], canopy_holly_snow:[64,64,11,16,54,64,1,1,1,0], sledge:[64,64,6,30,59,64,2,1,1,0], barrels_snow:[64,64,5,21,58,64,1,1,1,0], woodpile_snow:[64,64,6,19,57,64,1,1,1,0], crates_snow:[64,64,7,12,58,64,1,1,1,0],
    ice_block_stack:[64,64,7,19,58,64,1,1,1,0], fence_snow_ew:[64,64,5,35,59,64,2,1,1,0], fence_snow_post:[64,64,28,37,36,64,1,1,1,0],
    hay_bale_snow:[64,64,11,23,53,64,1,1,1,0], hay_feeder:[64,64,7,9,58,64,2,1,1,0], cabbage_bed_snow:[64,64,7,28,57,64,2,1,1,0],
    turnip_clamp:[64,64,2,27,61,64,2,1,1,0], trough_frozen:[64,64,5,28,59,64,2,1,1,0], lantern_post_ice:[64,64,17,9,47,64,1,1,9,120],
    banner_pole_frost:[64,64,17,7,47,64,1,1,9,120], well_frozen:[64,64,13,10,51,64,1,1,1,0], tent_snow:[64,64,3,9,62,64,2,2,1,0],
    campfire_snow:[64,64,9,21,56,64,1,1,9,120], brazier:[64,64,14,20,51,64,1,1,9,120], canopy_birch_white:[64,64,18,5,48,64,1,1,1,0],
    canopy_spruce_young:[64,64,19,25,45,64,1,1,1,0], 'creature:reindeer':[64,64,21,19,42,64,1,1,6,130], 'creature:mountain_goat':[64,64,23,31,41,64,1,1,6,120],
  },
  sunscar: {
    dry_bush:[64,64,9,25,55,64,1,1,1,0], desert_flowers:[64,64,15,25,49,64,1,1,1,0], rock_s_sand:[64,64,13,34,52,64,1,1,1,0], agave:[64,64,5,14,59,64,1,1,1,0], cactus_cluster:[64,64,12,11,53,64,1,1,1,0], dead_scrub:[64,64,10,22,53,64,1,1,1,0], canopy_thornbush:[64,64,5,23,64,64,1,1,1,0], canopy_dead_scrub_low:[64,64,6,34,59,64,1,1,1,0], stump_palm:[64,64,14,21,50,64,1,1,1,0], boulder_sand:[64,64,4,16,60,64,2,1,1,0], rock_l_sand:[64,64,5,22,59,64,1,1,1,0], canopy_date_palm:[64,64,2,3,62,64,1,1,1,0], canopy_palm_young:[64,64,11,16,55,64,1,1,1,0], canopy_acacia:[64,64,1,11,63,64,1,1,1,0], canopy_fan_palm:[64,64,5,5,59,64,1,1,1,0], canopy_fig:[64,64,2,7,60,64,1,1,1,0], irrigation_gate:[64,64,7,10,57,64,2,1,1,0], water_jars:[64,64,9,17,55,64,1,1,1,0], clay_pots:[64,64,7,22,56,64,1,1,1,0], spice_sacks:[64,64,5,18,59,64,2,1,1,0], hitching_post:[64,64,21,17,42,64,1,1,1,0],
    fence_reed_ew:[64,64,3,26,60,64,2,1,1,0], fence_reed_post:[64,64,25,26,39,64,1,1,1,0], goat_pen_gate:[64,64,8,18,57,64,2,1,1,0],
    shadoof:[64,64,5,3,59,64,2,2,9,140], date_basket:[64,64,10,29,54,64,1,1,1,0], melon_patch:[64,64,2,27,61,64,2,1,1,0],
    millet_bed:[64,64,5,13,60,64,2,2,1,0], oil_lamp_post:[64,64,19,7,44,64,1,1,9,120], banner_sun:[64,64,18,5,46,64,1,1,9,120],
    well_stone:[64,64,5,13,59,64,2,2,1,0], tent_desert:[64,64,6,7,58,64,2,2,1,0], campfire_desert:[64,64,6,19,58,64,1,1,9,120],
    brazier_desert:[64,64,14,13,50,64,1,1,9,120], canopy_date_palm_b:[64,64,6,7,58,64,1,1,1,0], canopy_olive:[64,64,4,6,63,64,1,1,1,0],
    'creature:camel':[64,64,22,21,41,64,1,1,6,130], 'creature:desert_goat':[64,64,23,33,41,64,1,1,6,120],
  },
  cinderfall: {
    dead_shrub:[64,64,7,14,56,64,1,1,1,0], canopy_red_fern:[64,64,5,28,58,64,1,1,1,0], canopy_lava_shrub:[64,64,6,27,58,64,1,1,1,0], canopy_burnt_bramble:[64,64,2,31,62,64,1,1,1,0], rock_s_basalt:[64,64,13,30,50,64,1,1,1,0], stump_burnt:[64,64,6,19,58,64,1,1,1,0], slag_lump:[64,64,9,25,55,64,1,1,1,0], mushroom_stump_ember:[64,64,15,19,49,64,1,1,1,0], boulder_basalt:[64,64,5,21,59,64,2,1,1,0], rock_l_basalt:[64,64,9,24,55,64,1,1,1,0], obsidian_pile_low:[64,64,3,28,61,64,2,1,1,0], canopy_red_sapling:[64,64,12,16,51,64,1,1,1,0], canopy_ash_birch:[64,64,8,2,54,64,1,1,1,0], canopy_ember_maple:[64,64,1,2,63,64,1,1,1,0], mushroom_log_ember:[64,64,4,24,60,64,2,1,1,0], ash_barrow:[64,64,1,21,63,64,2,1,1,0], barrel:[64,64,15,20,49,64,1,1,1,0], crates_stacked:[64,64,14,12,50,64,1,1,1,0], cordwood_row_ew:[64,64,1,35,64,64,2,1,1,0],
    canopy_red_rowan:[64,64,5,5,59,64,1,1,1,0], cordwood_stack:[64,64,5,16,59,64,2,2,1,0], mushroom_cluster_ember:[64,64,12,26,53,64,2,1,1,0],
    charcoal_sacks:[64,64,6,17,59,64,2,2,1,0], charcoal_sack_open:[64,64,6,23,58,64,2,1,1,0], charcoal_basket:[64,64,9,16,56,64,2,2,1,0],
    pen_fence_ew:[64,64,8,28,56,64,2,1,1,0], pen_gate:[64,64,8,28,56,64,2,1,1,0], pen_post:[64,64,25,34,39,64,1,1,1,0],
    ingot_stack:[64,64,6,26,58,64,2,1,1,0], slag_trough:[64,64,5,23,60,64,2,1,1,0], tent:[64,64,2,8,62,64,2,2,1,0],
    campfire:[64,64,9,26,55,64,1,1,9,120], brazier_post:[64,64,21,10,43,64,1,1,9,120], lamp_post_ember:[64,64,23,2,41,64,1,1,9,120],
    banner_pennant:[64,64,9,11,55,64,1,1,9,120], banner_hanging:[64,64,15,10,49,64,1,1,9,140],
    'creature:obsidian_goat':[64,64,22,31,42,64,1,1,6,120], 'creature:ash_hare':[64,64,26,37,39,64,1,1,6,110],
  },
  stormcairn: {
    canopy_heather_clump:[64,64,7,23,58,64,1,1,1,0], canopy_gorse:[64,64,2,20,62,64,1,1,1,0], canopy_bracken:[64,64,3,21,62,64,1,1,1,0], bog_cotton:[64,64,8,18,56,64,1,1,1,0], rock_s_granite:[64,64,13,39,51,64,1,1,1,0], canopy_broom:[64,64,6,10,61,64,1,1,1,0], thrift_rock:[64,64,6,26,58,64,2,1,1,0], boulder_granite:[64,64,6,20,58,64,2,1,1,0], rock_l_granite:[64,64,5,25,59,64,1,1,1,0], canopy_birch_downy:[64,64,13,2,53,64,1,1,1,0], canopy_rowan_wind:[64,64,14,8,64,64,1,1,1,0], canopy_juniper:[64,64,18,4,47,64,1,1,1,0], water_barrel:[64,64,23,40,41,64,1,1,1,0], salt_barrel:[64,64,23,38,41,64,1,1,1,0], creel_stack:[64,64,18,38,47,64,2,2,1,0], peat_creel:[64,64,20,39,46,64,2,2,1,0], sheep_hurdle:[64,64,5,26,60,64,2,1,1,0],
    dyke_ew:[64,64,0,32,64,64,2,1,1,0], dyke_ns:[64,64,25,0,39,64,1,2,1,0], dyke_gate:[64,64,1,26,64,64,2,1,1,0],
    peat_stack:[64,64,7,14,57,64,2,2,1,0], peat_stack_b:[64,64,1,17,63,64,2,2,1,0], hay_stook:[64,64,19,41,46,64,2,2,1,0],
    oat_stook:[64,64,23,36,41,64,1,1,1,0], trough_stone:[64,64,2,34,63,64,2,1,1,0], oat_rig:[64,64,1,36,63,64,2,1,1,0],
    oat_rig_b:[64,64,1,36,63,64,2,1,1,0], kale_bed:[64,64,3,19,61,64,2,2,1,0], lazybed:[64,64,1,10,64,64,2,2,1,0],
    bothy_tent:[64,64,1,10,64,64,2,2,1,0], peat_basket:[64,64,22,42,43,64,1,1,1,0], peat_fire:[64,64,5,19,59,64,1,1,9,120],
    lantern_post:[64,64,19,4,45,64,1,1,9,120], clan_pennant:[64,64,7,4,58,64,1,1,9,120], canopy_rowan_young:[64,64,12,9,54,64,1,1,1,0],
    canopy_alder:[64,64,4,4,63,64,1,1,1,0], 'creature:highland_cow':[64,64,19,23,46,64,1,1,6,150], 'creature:blackface_sheep':[64,64,21,27,43,64,1,1,6,120],
  },
};
// ART_KIT realm → id → same layout as KIT_ART: the ART lane's PixelLab crop beds, orchard trees (kind 'crop') and the
// kit's bridge pieces as PACK ships them in each realm atlas (pack/realm/<realm>/realm.json sprites.rects, round 2):
// realm-true crops for the tended ring (T3: Frostveil grows rye, kale and lingonberries, not pumpkins) and the
// designed crossings of basePaths. Merged into KIT_ART below (read-only views of PACK's measurements).
const ART_KIT = {
  sunscar: { bridge_ew_plank:[64,64,6,27,57,64,2,1,1,0], bridge_ns_plank:[64,64,15,6,49,64,1,2,1,0], crop_aubergine:[64,64,2,17,62,64,2,1,1,0], crop_barley:[64,64,4,13,60,64,2,2,1,0], crop_chickpea:[64,64,2,12,62,64,2,2,1,0], crop_cotton:[64,64,2,19,62,64,2,1,1,0], crop_herbs:[64,64,2,20,62,64,2,1,1,0], crop_lentil:[64,64,2,25,62,64,2,1,1,0], crop_onion:[64,64,1,18,62,64,2,1,1,0], crop_pepper:[64,64,2,12,62,64,2,2,1,0], crop_pumpkin:[64,64,1,23,62,64,2,2,1,0], crop_sesame:[64,64,2,3,62,64,2,2,1,0], crop_tomato:[64,64,2,4,62,64,2,2,1,0], crop_watermelon:[64,64,2,24,62,64,2,2,1,0], crop_wheat_young:[64,64,2,16,62,64,2,2,1,0], orchard_fig:[64,64,8,8,55,64,1,1,1,0], orchard_orange:[64,64,8,10,55,64,1,1,1,0], orchard_pomegranate:[64,64,8,8,55,64,1,1,1,0] },
  frostveil: { bridge_ew_mid_snow:[64,64,3,25,61,64,2,1,1,0], bridge_ns_mid_snow:[64,64,10,11,54,64,1,2,1,0], crop_barley_young:[64,64,1,23,63,64,2,2,1,0], crop_cabbage:[64,64,2,27,62,64,2,1,1,0], crop_clover:[64,64,1,27,63,64,2,1,1,0], crop_frost_barley:[64,64,1,16,63,64,2,1,1,0], crop_hay_stubble:[64,64,1,28,63,64,2,2,1,0], crop_herbs:[64,64,1,23,63,64,2,1,1,0], crop_kale:[64,64,1,23,63,64,2,2,1,0], crop_lingonberry:[64,64,1,24,63,64,2,2,1,0], crop_mustard:[64,64,1,15,63,64,2,2,1,0], crop_onion:[64,64,2,22,62,64,2,1,1,0], crop_potato:[64,64,2,21,62,64,2,2,1,0], crop_turnip:[64,64,1,26,63,64,2,2,1,0], crop_winter_rye:[64,64,1,16,63,64,2,2,1,0], orchard_frost_apple:[64,64,10,13,53,64,1,1,1,0], orchard_plum:[64,64,10,13,53,64,1,1,1,0], orchard_rowan:[64,64,10,13,53,64,1,1,1,0] },
  cinderfall: { bridge_end_e:[64,64,2,14,63,64,2,2,1,0], bridge_end_n:[64,64,9,6,56,64,2,2,1,0], bridge_ew_iron:[64,64,1,26,63,64,2,1,1,0], bridge_ew_iron_bank:[64,64,1,26,63,64,2,1,1,0], bridge_ns_iron:[64,64,11,2,53,64,1,2,1,0], crop_amaranth:[64,64,5,15,59,64,2,2,1,0], crop_ash_potato:[64,64,2,15,62,64,2,2,1,0], crop_beet:[64,64,5,26,59,64,2,1,1,0], crop_black_bean:[64,64,5,26,59,64,2,1,1,0], crop_ember_grain:[64,64,5,11,59,64,2,2,1,0], crop_ember_mushroom:[64,64,5,22,59,64,2,2,1,0], crop_millet:[64,64,5,22,59,64,2,1,1,0], crop_onion:[64,64,5,15,59,64,2,2,1,0], crop_pumpkin:[64,64,3,19,60,64,2,2,1,0], crop_red_cabbage:[64,64,5,19,59,64,2,2,1,0], crop_sulphur_bloom:[64,64,5,18,59,64,2,2,1,0], orchard_dark_cherry:[64,64,5,7,59,64,1,1,1,0], orchard_ember_plum:[64,64,5,7,59,64,1,1,1,0], orchard_pomegranate:[64,64,6,9,58,64,1,1,1,0] },
  crownlands: { bridge_ew_left:[64,64,9,21,59,64,2,2,1,0], bridge_ew_mid:[64,64,4,27,60,64,2,2,1,0], bridge_ew_right:[64,64,5,21,55,64,2,2,1,0], bridge_ns_mid_wide:[96,96,13,36,83,96,3,2,1,0], crop_barley:[64,64,3,16,61,64,2,1,1,0], crop_bean:[64,64,3,17,61,64,2,1,1,0], crop_cabbage:[64,64,3,23,61,64,2,2,1,0], crop_carrot:[64,64,3,18,61,64,2,2,1,0], crop_flax:[64,64,3,18,61,64,2,1,1,0], crop_hay_stubble:[64,64,3,25,61,64,2,2,1,0], crop_lavender:[64,64,3,17,61,64,2,2,1,0], crop_lettuce:[64,64,3,25,61,64,2,2,1,0], crop_oats:[64,64,3,14,61,64,2,2,1,0], crop_pumpkin:[64,64,3,26,61,64,2,1,1,0], crop_strawberry:[64,64,3,22,61,64,2,2,1,0], crop_sunflower:[64,64,3,6,61,64,2,1,1,0], crop_turnip:[64,64,3,20,61,64,2,2,1,0], orchard_apple:[64,64,10,8,53,64,1,1,1,0], orchard_cherry:[64,64,10,11,53,64,1,1,1,0], orchard_pear:[64,64,11,11,53,64,1,1,1,0] },
  stormcairn: { crop_bere_barley:[64,64,1,36,63,64,2,1,1,0], crop_cabbage:[64,64,1,43,63,64,2,1,1,0], crop_clover:[64,64,2,13,62,64,2,2,1,0], crop_flax:[64,64,1,36,63,64,2,1,1,0], crop_hay_stubble:[64,64,2,13,61,64,2,2,1,0], crop_herbs:[64,64,1,37,63,64,2,1,1,0], crop_kale:[64,64,5,25,59,64,2,2,1,0], crop_mustard:[64,64,0,9,63,64,2,2,1,0], crop_oats_young:[64,64,1,36,63,64,2,1,1,0], crop_onion:[64,64,3,8,61,64,2,2,1,0], crop_potato:[64,64,2,10,61,64,2,2,1,0], crop_rhubarb:[64,64,2,10,62,64,2,2,1,0], crop_turnip:[64,64,0,10,63,64,2,2,1,0], orchard_crab_apple:[64,64,8,8,55,64,1,1,1,0], orchard_rowan:[64,64,8,7,56,64,1,1,1,0], orchard_wild_plum:[64,64,8,8,55,64,1,1,1,0] },
};
for (const [r, t] of Object.entries(ART_KIT)) Object.assign(KIT_ART[r], t);
// Stage B: the three catch-up realms (D-170), read from PACK's realm.json sprites.rects (ink, footprint, frames) and the
// creature sheets' frame 0 'down' (spr.png) at the final kit SHAs: Elderwood 99147f20, Thornwake e02e40b8, Solana Reach
// a65cede0 (the ART orchard trees are in Solana's atlas). Only ids KIT_DRESSING uses; a test checks every row against
// the pack it was read from, so a re-sync that moves a prop fails loudly instead of seating it wrong.
Object.assign(KIT_ART, {
  elderwood: { ribbon_post:[64,64,15,4,50,64,1,1,9,130], lantern_post_wood:[64,64,20,6,44,64,1,1,9,120], lantern_hanging:[64,64,19,11,45,64,1,1,9,120], campfire:[64,64,5,22,59,64,1,1,9,110], tent_hide:[64,64,3,10,62,64,2,2,1,0], tent_hide_b:[64,64,4,13,61,64,2,2,1,0], firewood_bundle:[64,64,9,30,55,64,1,1,1,0], herb_bed_ew:[64,64,1,35,62,64,2,1,1,0], herb_bed_c:[64,64,2,35,62,64,2,1,1,0], herb_bed_b:[64,64,2,39,62,64,2,1,1,0], mushroom_logs:[64,64,2,20,62,64,2,1,1,0], fern_low:[64,64,11,32,53,64,1,1,1,0], toadstools:[64,64,16,32,48,64,1,1,1,0], basket_stack:[64,64,6,16,59,64,1,1,1,0], fruit_basket:[64,64,13,19,51,64,1,1,1,0], sacks_grain:[64,64,8,22,57,64,1,1,1,0], well_mossy:[64,64,10,7,54,64,1,1,1,0], bee_skep:[64,64,9,19,55,64,1,1,1,0], hive_box:[64,64,13,16,51,64,1,1,1,0], bee_skep_b:[64,64,4,27,60,64,2,1,1,0], acorn_trough:[64,64,3,31,62,64,2,1,1,0], timber_cart:[64,64,2,20,63,64,2,1,1,0], goose_house:[64,64,5,14,59,64,2,1,1,0], crates_wood:[64,64,11,10,54,64,1,1,1,0], barrel_oak:[64,64,15,16,50,64,1,1,1,0], log_pile:[64,64,2,10,62,64,2,1,1,0], chopping_block:[64,64,10,14,55,64,1,1,1,0], axe_rack:[64,64,4,11,60,64,2,1,1,0], apple_tree:[64,64,9,14,55,64,1,1,1,0], apple_tree_b:[64,64,8,11,56,64,1,1,1,0], apple_tree_c:[64,64,11,16,53,64,1,1,1,0], plum_tree:[64,64,7,13,57,64,1,1,1,0], plum_tree_b:[64,64,6,16,58,64,1,1,1,0], 'creature:goose':[64,64,24,35,40,64,1,1,6,130], 'creature:wild_boar':[64,64,22,29,42,64,1,1,6,120], canopy_fern_bush:[64,64,4,18,60,64,1,1,1,0], canopy_bramble_small:[64,64,8,27,57,64,1,1,1,0], canopy_elder_bush_small:[64,64,13,30,54,64,1,1,1,0], foxgloves:[64,64,12,3,53,64,1,1,1,0], bluebell_clump_b:[64,64,13,29,51,64,1,1,1,0], toadstools_b:[64,64,15,22,49,64,1,1,1,0], rock_s_moss:[64,64,15,19,49,64,1,1,1,0], rock_l_moss:[64,64,3,23,61,64,1,1,1,0], boulder_moss:[64,64,2,16,62,64,2,1,1,0], stump_oak:[64,64,6,27,59,64,1,1,1,0], stump_oak_low:[64,64,8,33,56,64,1,1,1,0], fallen_oak:[64,64,2,25,62,64,2,1,1,0], canopy_sapling:[64,64,14,7,51,64,1,1,1,0], canopy_hazel_coppice:[64,64,5,6,59,64,1,1,1,0], canopy_elder_oak:[64,64,1,2,62,64,1,1,1,0], canopy_moss_beech:[64,64,2,2,62,64,1,1,1,0], canopy_holly:[64,64,10,5,55,64,1,1,1,0], canopy_twisted_beech:[64,64,3,4,64,64,1,1,1,0], root_bridge_ew:[64,64,2,18,62,64,2,1,1,0], wattle_fence_ew:[64,64,1,27,63,64,2,1,1,0], wattle_fence_post:[64,64,24,22,40,64,1,1,1,0], wattle_gate:[64,64,9,21,56,64,2,1,1,0] },
  thornwake: { carved_post:[64,64,19,10,45,64,1,1,1,0], bamboo_torch:[64,64,28,9,36,64,1,1,9,110], dock_lantern:[64,64,16,10,48,64,1,1,9,120], cookfire:[64,64,13,26,52,64,1,1,9,120], hammock_posts:[64,64,2,12,62,64,2,1,1,0], drying_rack:[64,64,3,19,61,64,2,1,1,0], rice_ripe_ew:[64,64,1,23,63,64,2,1,1,0], rice_young_ew:[64,64,7,40,57,64,2,1,1,0], rice_tall_ew:[64,64,3,25,62,64,2,1,1,0], rice_seedlings:[64,64,6,27,58,64,2,1,1,0], rice_young_ew_b:[64,64,3,42,61,64,2,1,1,0], rice_sheaves:[64,64,10,18,54,64,1,1,1,0], canopy_fern_small:[64,64,8,29,57,64,1,1,1,0], scarecrow_bamboo:[64,64,11,4,53,64,1,1,1,0], rice_mortar:[64,64,21,7,44,64,1,1,1,0], rice_sacks:[64,64,4,18,60,64,2,1,1,0], water_jars:[64,64,3,17,61,64,2,1,1,0], bamboo_spout:[64,64,6,13,59,64,2,1,9,110], fowl_coop:[64,64,6,6,59,64,2,2,1,0], pottery_jars:[64,64,8,21,57,64,2,1,1,0], mud_wallow:[64,64,2,34,62,64,2,1,1,0], stilt_granary:[64,64,3,1,61,64,2,2,1,0], fish_smoking_rack:[64,64,4,13,60,64,2,1,1,0], basket_stack:[64,64,7,21,57,64,2,1,1,0], crates_bamboo:[64,64,6,9,58,64,2,1,1,0], fruit_baskets:[64,64,4,22,60,64,2,1,1,0], canopy_banana:[64,64,4,6,62,64,1,1,1,0], canopy_mango:[64,64,3,5,61,64,1,1,1,0], canopy_banana_young:[64,64,6,11,57,64,1,1,1,0], canopy_mango_b:[64,64,3,6,62,64,1,1,1,0], 'creature:jungle_fowl':[64,64,26,37,39,64,1,1,6,110], 'creature:jungle_boar':[64,64,22,29,42,64,1,1,6,120], canopy_giant_fern:[64,64,3,11,62,64,1,1,1,0], canopy_orchid_bush:[64,64,3,19,62,64,1,1,1,0], heliconia:[64,64,3,4,62,64,1,1,1,0], pitcher_plants:[64,64,6,10,59,64,1,1,1,0], canopy_vine_tangle:[64,64,6,27,59,64,1,1,1,0], canopy_cycad_small:[64,64,6,19,56,64,1,1,1,0], rock_s_jungle:[64,64,15,37,50,64,1,1,1,0], rock_l_jungle:[64,64,4,17,61,64,1,1,1,0], boulder_jungle:[64,64,3,15,61,64,2,1,1,0], stump_jungle:[64,64,3,3,62,64,1,1,1,0], termite_mound:[64,64,8,4,57,64,1,1,1,0], canopy_tree_fern_young:[64,64,6,20,58,64,1,1,1,0], canopy_jungle_palm:[64,64,2,3,61,64,1,1,1,0], canopy_bamboo:[64,64,10,5,56,64,1,1,1,0], canopy_kapok:[64,64,3,2,62,64,1,1,1,0], canopy_rubber_tree:[64,64,3,3,61,64,1,1,1,0], canopy_strangler_fig:[64,64,4,3,61,64,1,1,1,0], rope_bridge_ns:[64,64,10,0,54,64,1,2,1,0], stilt_pier_ew:[64,64,0,25,64,64,2,1,1,0], bamboo_fence_ew:[64,64,1,36,63,64,2,1,1,0], bamboo_fence_post:[64,64,26,10,39,64,1,1,1,0], bamboo_gate:[64,64,3,28,61,64,2,1,1,0] },
  'seeker-reach': { banner_prism:[64,64,8,8,55,64,1,1,9,130], lantern_crystal:[64,64,16,4,47,64,1,1,9,130], beacon_lamp_post:[64,64,25,5,39,64,1,1,9,130], glow_brazier:[64,64,14,17,50,64,1,1,9,120], tent_violet:[64,64,2,5,62,64,2,2,1,0], tent_teal:[64,64,2,5,62,64,2,2,1,0], harvest_basket:[64,64,10,20,53,64,1,1,1,0], crystal_bed_ew:[64,64,4,34,60,64,2,1,1,0], glowmoss_plot:[64,64,4,47,60,64,2,1,1,0], crystal_seedling_tray:[64,64,6,31,58,64,2,1,1,0], crystal_bed_b:[64,64,4,34,60,64,2,1,1,0], crystal_cluster_small_teal:[64,64,19,30,45,64,1,1,1,0], crystal_cluster_small_violet:[64,64,18,29,45,64,1,1,1,0], sorting_table:[64,64,5,23,59,64,2,1,1,0], harvest_cart:[64,64,7,24,56,64,2,1,1,0], sacks_dust:[64,64,7,22,57,64,2,1,1,0], refinery_still:[64,64,13,10,51,64,1,1,9,140], pedestal_lens:[64,64,21,17,43,64,1,1,1,0], crystal_rack_ew:[64,64,4,21,60,64,2,1,1,0], shard_crates:[64,64,6,16,58,64,1,1,1,0], harvest_shed:[64,64,5,6,58,64,2,2,1,0], crystal_cart:[64,64,4,8,59,64,2,2,1,0], crates_market:[64,64,3,9,60,64,1,1,1,0], dock_crates_shard:[64,64,7,10,56,64,1,1,1,0], orchard_amethyst:[64,64,8,8,55,64,1,1,1,0], orchard_lumen:[64,64,10,10,53,64,1,1,1,0], orchard_teal_crystal:[64,64,8,7,55,64,1,1,1,0], 'creature:rock_tortoise':[64,64,21,39,43,64,1,1,6,140], 'creature:crystal_beetle':[64,64,22,38,43,64,1,1,6,110], canopy_crystal_shrub:[64,64,10,35,54,64,1,1,1,0], canopy_crystal_shrub_teal:[64,64,7,32,58,64,1,1,1,0], canopy_lichen_bush:[64,64,7,26,58,64,1,1,1,0], silver_fern:[64,64,4,15,60,64,1,1,1,0], glowcap_cluster:[64,64,14,18,49,64,1,1,1,0], canopy_thorn_violet:[64,64,6,24,59,64,1,1,1,0], rock_s_slate:[64,64,17,36,47,64,1,1,1,0], rock_s_slate_b:[64,64,12,41,52,64,1,1,1,0], rock_l_slate:[64,64,3,15,60,64,1,1,1,0], boulder_slate:[64,64,6,17,58,64,2,1,1,0], stump_petrified:[64,64,9,20,55,64,1,1,1,0], crystal_cluster_violet:[64,64,12,14,52,64,1,1,1,0], canopy_crystal_teal_s:[64,64,12,8,51,64,1,1,1,0], canopy_crystal_amethyst_s:[64,64,12,6,51,64,1,1,1,0], canopy_silver_birch:[64,64,4,3,60,64,1,1,1,0], canopy_petrified_pine:[64,64,11,3,53,64,1,1,1,0], canopy_glowcap_s:[64,64,10,17,51,64,1,1,1,0], lens_fence_ew:[64,64,5,41,59,64,2,1,1,0], lens_fence_post:[64,64,26,30,37,64,1,1,1,0], lens_gate:[64,64,4,30,59,64,2,1,1,0] },
});

/** Per-realm plot dressing by role (C9 / Q8: game-v4 has no banners, lights, gardens or livestock, so
 *  they come from the realm's own kit). Each role lists candidates in preference order; the composer
 *  takes the first one that obeys the sky law at the level (a tent taller than a founding keep waits
 *  until the keep outgrows it) and omits the role otherwise. */
export const KIT_DRESSING = Object.freeze({
  crownlands: { banner: ['banner_pole'], light: ['lantern_post'], brazier: ['lantern_post'], campfire: ['campfire'], tent: ['tent', 'hay_bale'],
    crops: ['wheat_ripe', 'crop_barley', 'crop_oats', 'crop_cabbage', 'crop_carrot', 'crop_flax', 'crop_turnip', 'crop_lettuce', 'crop_bean', 'crop_strawberry', 'crop_sunflower', 'crop_lavender', 'crop_pumpkin', 'wheat_young'], fieldFill: ['flowers', 'dry_grass'], fieldProp: ['scarecrow', 'hay_bale', 'cart_hay'],
    hay: ['hay_bale'], well: ['well'], hive: ['beehive'], farm: ['cart_hay', 'trough'], clutter: ['barrels', 'crates', 'grain_sacks', 'log_pile', 'chopping_block'],
    orchard: ['orchard_apple', 'orchard_pear', 'orchard_cherry'], livestock: ['creature:sheep', 'creature:pig'],
    wildSmall: ['bush', 'berry_bush', 'flowers', 'dry_grass', 'mushrooms', 'canopy_sapling'], wildRock: ['rock_s', 'rock_l', 'boulder_mossy', 'stump', 'log'],
    wildTree: ['canopy_oak_young', 'birch', 'pine', 'canopy_rowan', 'canopy_hawthorn'],
    bridge: { ew: 'bridge_ew_mid', ns: 'bridge_ns_mid_wide' },   // Stage B: the final kit (07b4bde7) has only the wide N–S deck
    pen: { ew: 'fence_ew', post: 'fence_post' }, edge: { ew: 'fence_ew', post: 'fence_post' } },
  frostveil: { banner: ['banner_pole_frost'], light: ['lantern_post_ice'], brazier: ['brazier'], campfire: ['campfire_snow'], tent: ['tent_snow', 'hay_bale_snow'],
    crops: ['crop_winter_rye', 'crop_kale', 'crop_frost_barley', 'crop_potato', 'crop_lingonberry', 'crop_cabbage', 'crop_turnip', 'crop_mustard', 'crop_barley_young', 'crop_clover', 'crop_onion', 'cabbage_bed_snow'], fieldFill: ['snow_mound', 'rock_s_frost'], fieldProp: ['sledge'],
    hay: ['hay_bale_snow'], well: ['well_frozen'], hive: ['ice_block_stack'], farm: ['hay_feeder', 'trough_frozen'], clutter: ['barrels_snow', 'woodpile_snow', 'crates_snow', 'sledge'],
    orchard: ['orchard_frost_apple', 'orchard_plum', 'orchard_rowan'], livestock: ['creature:reindeer', 'creature:mountain_goat'],
    wildSmall: ['bush_snow', 'frosted_shrub', 'holly_snow', 'berry_bush_frost', 'canopy_sapling_snow', 'canopy_juniper', 'canopy_bramble_frost'],
    wildRock: ['rock_s_frost', 'rock_l_frost', 'boulder_snow', 'stump_snow', 'snow_mound'], wildTree: ['canopy_spruce_young', 'canopy_spruce', 'canopy_fir_snow', 'canopy_birch_white', 'canopy_holly_snow'],
    bridge: { ew: 'bridge_ew_mid_snow', ns: 'bridge_ns_mid_snow' },
    pen: { ew: 'fence_snow_ew', post: 'fence_snow_post' }, edge: { ew: 'fence_snow_ew', post: 'fence_snow_post' } },
  sunscar: { banner: ['banner_sun'], light: ['oil_lamp_post'], brazier: ['brazier_desert'], campfire: ['campfire_desert'], tent: ['tent_desert', 'date_basket'],
    crops: ['millet_bed', 'crop_barley', 'crop_chickpea', 'crop_sesame', 'crop_lentil', 'crop_cotton', 'crop_watermelon', 'crop_onion', 'crop_pepper', 'crop_tomato', 'crop_aubergine', 'crop_herbs', 'melon_patch'], fieldFill: ['desert_flowers'], fieldProp: ['irrigation_gate', 'water_jars', 'shadoof'],
    hay: ['date_basket'], well: ['well_stone'], hive: ['date_basket'], farm: ['shadoof'], clutter: ['water_jars', 'clay_pots', 'spice_sacks', 'date_basket', 'hitching_post'],
    orchard: ['orchard_fig', 'orchard_pomegranate', 'orchard_orange', 'canopy_date_palm_b'], livestock: ['creature:camel', 'creature:desert_goat'],
    wildSmall: ['dry_bush', 'desert_flowers', 'agave', 'cactus_cluster', 'dead_scrub', 'canopy_thornbush', 'canopy_dead_scrub_low'],
    wildRock: ['rock_s_sand', 'rock_l_sand', 'boulder_sand', 'stump_palm'], wildTree: ['canopy_palm_young', 'canopy_date_palm', 'canopy_acacia', 'canopy_fan_palm'],
    bridge: { ew: 'bridge_ew_plank', ns: 'bridge_ns_plank' },
    pen: { ew: 'fence_reed_ew', post: 'fence_reed_post', gate: 'goat_pen_gate' }, edge: { ew: 'fence_reed_ew', post: 'fence_reed_post' } },
  cinderfall: { banner: ['banner_pennant', 'banner_hanging'], light: ['lamp_post_ember'], brazier: ['brazier_post'], campfire: ['campfire'], tent: ['tent', 'charcoal_sacks'],
    crops: ['crop_ember_grain', 'crop_ash_potato', 'crop_amaranth', 'crop_red_cabbage', 'crop_beet', 'crop_black_bean', 'crop_ember_mushroom', 'crop_millet', 'crop_sulphur_bloom', 'crop_onion', 'mushroom_cluster_ember', 'mushroom_log_ember'], fieldFill: ['mushroom_stump_ember'], fieldProp: ['ash_barrow', 'charcoal_basket'],
    hay: ['charcoal_sacks'], well: ['slag_trough'], hive: ['ingot_stack'], farm: ['charcoal_basket', 'cordwood_stack'], clutter: ['barrel', 'crates_stacked', 'cordwood_row_ew', 'ingot_stack'],
    orchard: ['orchard_ember_plum', 'orchard_dark_cherry', 'orchard_pomegranate'], livestock: ['creature:obsidian_goat', 'creature:ash_hare'],
    wildSmall: ['dead_shrub', 'canopy_red_fern', 'canopy_lava_shrub', 'canopy_burnt_bramble', 'slag_lump'],
    wildRock: ['rock_s_basalt', 'rock_l_basalt', 'boulder_basalt', 'stump_burnt', 'obsidian_pile_low'], wildTree: ['canopy_red_sapling', 'canopy_red_rowan', 'canopy_ash_birch', 'canopy_ember_maple'],
    bridge: { ew: 'bridge_ew_iron', ns: 'bridge_ns_iron' },
    pen: { ew: 'pen_fence_ew', post: 'pen_post', gate: 'pen_gate' }, edge: { ew: 'pen_fence_ew', post: 'pen_post' } },
  stormcairn: { banner: ['clan_pennant'], light: ['lantern_post'], brazier: ['peat_fire'], campfire: ['peat_fire'], tent: ['bothy_tent', 'hay_stook'],
    crops: ['oat_rig', 'crop_bere_barley', 'kale_bed', 'crop_potato', 'crop_oats_young', 'crop_turnip', 'crop_cabbage', 'crop_flax', 'crop_rhubarb', 'crop_clover', 'lazybed', 'crop_mustard'], fieldFill: ['oat_stook'], fieldProp: ['hay_stook', 'sheep_hurdle'],
    hay: ['hay_stook', 'oat_stook'], well: ['trough_stone'], hive: ['peat_basket'], farm: ['peat_stack', 'peat_stack_b'], clutter: ['water_barrel', 'salt_barrel', 'peat_basket', 'creel_stack', 'peat_creel'],
    orchard: ['orchard_crab_apple', 'orchard_wild_plum', 'orchard_rowan'], livestock: ['creature:highland_cow', 'creature:blackface_sheep'],
    wildSmall: ['canopy_heather_clump', 'canopy_gorse', 'canopy_bracken', 'bog_cotton', 'canopy_broom'],
    wildRock: ['rock_s_granite', 'rock_l_granite', 'boulder_granite', 'thrift_rock'], wildTree: ['canopy_rowan_young', 'canopy_juniper', 'canopy_birch_downy', 'canopy_rowan_wind', 'canopy_alder'],
    bridge: {},
    pen: { ew: 'dyke_ew', ns: 'dyke_ns', gate: 'dyke_gate' }, edge: { ew: 'dyke_ew', ns: 'dyke_ns' } },
  // Stage B (D-170): each from its own kit. Elderwood is a woodland of herb gardens, mushroom logs, skeps, geese and
  // boar behind wattle; Thornwake farms rice paddies behind bamboo, with fowl and jungle boar; Solana Reach tends crystal
  // beds and ART's crystal orchards behind the lens fence, with rock tortoises and crystal beetles, and its chimneys
  // breathe the kit's vapour (it has no smoke_drift). Candidates are in sky-law order: the first that fits the level.
  elderwood: { banner: ['ribbon_post'], light: ['lantern_post_wood'], brazier: ['lantern_hanging', 'lantern_post_wood'], campfire: ['campfire'], tent: ['tent_hide', 'tent_hide_b', 'firewood_bundle'],
    crops: ['herb_bed_ew', 'herb_bed_c', 'herb_bed_b', 'mushroom_logs'], fieldFill: ['fern_low', 'toadstools'], fieldProp: ['basket_stack', 'fruit_basket', 'sacks_grain'],
    hay: ['firewood_bundle', 'sacks_grain'], well: ['well_mossy'], hive: ['bee_skep', 'hive_box', 'bee_skep_b'], farm: ['acorn_trough', 'timber_cart', 'goose_house'],
    clutter: ['crates_wood', 'barrel_oak', 'log_pile', 'chopping_block', 'axe_rack', 'basket_stack'],
    orchard: ['apple_tree', 'plum_tree', 'apple_tree_b', 'plum_tree_b', 'apple_tree_c'], livestock: ['creature:goose', 'creature:wild_boar'],
    wildSmall: ['canopy_fern_bush', 'canopy_bramble_small', 'canopy_elder_bush_small', 'fern_low', 'foxgloves', 'bluebell_clump_b', 'toadstools_b'],
    wildRock: ['rock_s_moss', 'rock_l_moss', 'boulder_moss', 'stump_oak', 'stump_oak_low', 'fallen_oak'],
    wildTree: ['canopy_sapling', 'canopy_hazel_coppice', 'canopy_elder_oak', 'canopy_moss_beech', 'canopy_holly', 'canopy_twisted_beech'],
    bridge: { ew: 'root_bridge_ew' },
    pen: { ew: 'wattle_fence_ew', post: 'wattle_fence_post', gate: 'wattle_gate' }, edge: { ew: 'wattle_fence_ew', post: 'wattle_fence_post' } },
  thornwake: { banner: ['carved_post'], light: ['bamboo_torch'], brazier: ['bamboo_torch', 'dock_lantern'], campfire: ['cookfire'], tent: ['hammock_posts', 'drying_rack'],
    crops: ['rice_young_ew', 'rice_ripe_ew', 'rice_seedlings', 'rice_tall_ew', 'rice_young_ew_b'], fieldFill: ['rice_sheaves', 'canopy_fern_small'], fieldProp: ['scarecrow_bamboo', 'rice_sheaves', 'rice_mortar'],
    hay: ['rice_sheaves', 'rice_sacks'], well: ['bamboo_spout', 'water_jars'], hive: ['fowl_coop', 'pottery_jars'], farm: ['mud_wallow', 'fish_smoking_rack', 'stilt_granary'],
    clutter: ['basket_stack', 'crates_bamboo', 'pottery_jars', 'rice_sacks', 'fruit_baskets', 'water_jars'],
    orchard: ['canopy_banana', 'canopy_mango', 'canopy_banana_young', 'canopy_mango_b'], livestock: ['creature:jungle_fowl', 'creature:jungle_boar'],
    wildSmall: ['canopy_fern_small', 'canopy_giant_fern', 'canopy_orchid_bush', 'heliconia', 'pitcher_plants', 'canopy_vine_tangle', 'canopy_cycad_small'],
    wildRock: ['rock_s_jungle', 'rock_l_jungle', 'boulder_jungle', 'stump_jungle', 'termite_mound'],
    wildTree: ['canopy_tree_fern_young', 'canopy_jungle_palm', 'canopy_bamboo', 'canopy_kapok', 'canopy_rubber_tree', 'canopy_strangler_fig'],
    bridge: { ew: 'stilt_pier_ew', ns: 'rope_bridge_ns' },
    pen: { ew: 'bamboo_fence_ew', post: 'bamboo_fence_post', gate: 'bamboo_gate' }, edge: { ew: 'bamboo_fence_ew', post: 'bamboo_fence_post' } },
  'seeker-reach': { banner: ['banner_prism'], light: ['lantern_crystal', 'beacon_lamp_post'], brazier: ['glow_brazier'], campfire: ['glow_brazier'], tent: ['tent_violet', 'tent_teal', 'harvest_basket'],
    crops: ['crystal_bed_ew', 'glowmoss_plot', 'crystal_seedling_tray', 'crystal_bed_b'], fieldFill: ['crystal_cluster_small_teal', 'crystal_cluster_small_violet'], fieldProp: ['harvest_basket', 'sorting_table', 'harvest_cart'],
    hay: ['sacks_dust', 'harvest_basket'], well: ['refinery_still', 'pedestal_lens'], hive: ['crystal_rack_ew', 'shard_crates'], farm: ['harvest_cart', 'harvest_shed', 'crystal_cart'],
    clutter: ['shard_crates', 'crates_market', 'sacks_dust', 'dock_crates_shard', 'harvest_basket'],
    orchard: ['orchard_amethyst', 'orchard_lumen', 'orchard_teal_crystal'], livestock: ['creature:rock_tortoise', 'creature:crystal_beetle'],
    wildSmall: ['canopy_crystal_shrub', 'canopy_crystal_shrub_teal', 'canopy_lichen_bush', 'silver_fern', 'glowcap_cluster', 'canopy_thorn_violet'],
    wildRock: ['rock_s_slate', 'rock_s_slate_b', 'rock_l_slate', 'boulder_slate', 'stump_petrified', 'crystal_cluster_violet'],
    wildTree: ['canopy_crystal_teal_s', 'canopy_crystal_amethyst_s', 'canopy_silver_birch', 'canopy_petrified_pine', 'canopy_glowcap_s'],
    bridge: {}, smoke: ['vapour_drift'],
    // the lens fence panel's ink is x 5..58 of 64: at the 2-tile pitch it leaves 11 px open at every joint (the kit butts
    // it at its 54-px ink pitch, 6aa5e72e). The pack's 16-piece lens-fence autotile (realm.json edges) is what draws the
    // plot edge and pens at 1-tile pitch; these kit pieces are only the fallback when that autotile is missing.
    pen: { ew: 'lens_fence_ew', post: 'lens_fence_post', gate: 'lens_gate' }, edge: { ew: 'lens_fence_ew', post: 'lens_fence_post' } },
});
const POLE_ROLES = new Set(['banner', 'light', 'brazier']);
/** Crop ids the kit authors as flat beds (kit.json kind 'decal'): they tile into continuous fields. Standing
 *  crops (Frostveil's turnip clamps, Cinderfall's mushroom clusters and charcoal sacks: kind 'low') are
 *  planted in spaced rows instead, so a field reads as a garden and not as a wall of objects. */
export const FLAT_CROPS = Object.freeze(new Set(['wheat_ripe', 'wheat_young', 'cabbage_bed_snow', 'millet_bed', 'melon_patch', 'oat_rig', 'oat_rig_b', 'kale_bed', 'lazybed',
  // Stage B: Elderwood's herb beds, Thornwake's rice rows (a paddy is one continuous field) and Solana Reach's crystal beds
  'herb_bed_ew', 'herb_bed_c', 'herb_bed_b', 'rice_young_ew', 'rice_young_ew_b', 'rice_ripe_ew', 'rice_tall_ew', 'rice_seedlings',
  'crystal_bed_ew', 'crystal_bed_b', 'glowmoss_plot', 'crystal_seedling_tray']));
/** ART's crop beds (PACK realm atlas, kind 'crop') are flat beds too: they tile into continuous fields. */
export const isFlatCrop = id => FLAT_CROPS.has(id) || id.startsWith('crop_');
const kindOfRole = (role, fallback) => (POLE_ROLES.has(role) ? 'pole' : fallback);

// ---- rules ------------------------------------------------------------------------------------------
const C = PLOT_CENTRE;                                   // 49: the plot centre (continuous)
const KW = KEEP_FOOTPRINT[0], KH = KEEP_FOOTPRINT[1];    // v1 today (C3)
const K0 = C - KW / 2;                                   // 48: keep footprint [48, 50)²
const LANES = Array.from({ length: KW }, (_, i) => K0 + i); // gate lanes = the keep's columns (48, 49)
const INSET = CAMPAIGN_LAYOUT.outerWallInset;            // 2: outer wall inset from the claim edge

/** The plot rule for a level (contracts.plotRule: claim, ring, wallTier, wallRings). */
export const rule = level => plotRule(level);
/** Decor band 0…5: L1 camp, L2 palisade, L3–4 holdfast, L5–8 stone hold, L9–12 citadel, L13–16
 *  stronghold, L17–20 grand citadel (plan §6.3 table rows). */
export function decorBand(L) { return L <= 1 ? 0 : L <= 4 ? 1 : L <= 8 ? 2 : L <= 12 ? 3 : L <= 16 ? 4 : 5; }

/** The plot geometry shared by GROUND (MAP plot overlay), PACK (plots.webp) and this module. */
export function plotGeometry(level, claimTiles) {
  const r = rule(level), S = claimTiles ?? r.claim, A = C - S / 2, B = C + S / 2;
  const P0 = A - r.ring, P1 = B + r.ring;
  const o0 = A + INSET, o1 = B - 1 - INSET, doubled = r.wallRings >= 3;
  const wIn = o0 + 1 + (doubled ? 1 : 0), wInHi = o1 - 1 - (doubled ? 1 : 0);
  const [q0, q1] = KEEP_FIT.courtyard;                   // [46, 52]
  const citadel = r.wallRings >= 2 ? [q0, q1 - 1] : null; // 6×6 ring [46, 51] with a south gate
  const court = citadel ? [q0 + 1, q1 - 1] : [q0, q1];   // free courtyard [47,51)² or [46,52)²
  return { level: r.level, S, A, B, ring: r.ring, P0, P1, o0, o1, doubled, wIn, wInHi, citadel, court,
    wallRings: r.wallRings, wallTier: r.wallTier, lanes: LANES.slice(), keep: [K0, K0 + KW] };
}
/** Is tile (x,y) on a gate lane (a road from the plot gate to the courtyard, kept free of decor)? */
function isLane(g, x, y) {
  const top = g.citadel ? g.citadel[0] : g.court[0];                // 46
  const southStop = g.citadel ? g.citadel[1] : g.court[1];          // the citadel's south gate row is a lane
  const west = g.citadel ? g.citadel[0] : g.court[0], east = g.citadel ? g.citadel[1] + 1 : g.court[1];
  if (LANES.includes(x) && (y < top || y >= southStop)) return true;
  if (LANES.includes(y) && (x < west || x >= east)) return true;
  return false;
}
/** Clockwise ring walk [a..b]² (south edge W→E first), the game's own perimeter order (world.ts). */
function ringWalk(a, b) {
  const out = [];
  if (b < a) return out;
  for (let x = a; x <= b; x++) out.push([x, b]);
  for (let y = b - 1; y >= a; y--) out.push([b, y]);
  for (let x = b - 1; x >= a; x--) out.push([x, a]);
  for (let y = a + 1; y <= b - 1; y++) out.push([a, y]);
  return out;
}
/** wallConnect.wallShape over one ring's own cells (each ring resolves alone, so a doubled wall reads as
 *  two clean curtains, not a lattice of tees; gate cheeks become end_* pieces). */
function resolvePieces(cells) {
  const has = new Set(cells.map(([x, y]) => x + ',' + y));
  const h = (x, y) => has.has(x + ',' + y);
  return cells.map(([x, y]) => {
    const n = h(x, y - 1), e = h(x + 1, y), s = h(x, y + 1), w = h(x - 1, y);
    return [x, y, wallShape({ n, e, s, w }), (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0)];
  });
}
/** ART's plot-edge autotile piece names by arm mask (N=1, E=2, S=4, W=8; mapkit/<realm>/edges/autotile). */
export const EDGE_ARMS = Object.freeze(['post', 'N', 'E', 'NE', 'S', 'NS', 'ES', 'NES', 'W', 'NW', 'EW', 'NEW', 'SW', 'NSW', 'ESW', 'NESW']);

// ---- keep ----------------------------------------------------------------------------------------------
const keepArt = L => GAME_ART[`keep/l${L}`];
/** Keep ink extents in tiles around its seat (x = C, y = the footprint's south edge) at true scale. */
export function keepExtents(level) {
  const L = rule(level).level, [w, h, ax, x0, y0, x1, y1] = keepArt(L), k = scaleOf('keep');
  return { left: (ax - x0) * k, right: (x1 - ax) * k, up: (h - y0) * k, down: (h - y1) * k, w: (x1 - x0) * k, h: (y1 - y0) * k };
}
/** kFit(L) (plan §6.7): the keep's enlargement at d 200–280, fitted into its courtyard's clear span. */
export function kFit(level) {
  const g = plotGeometry(level), e = keepExtents(level);
  const clear = g.citadel ? KEEP_FIT.clearTiles.citadel : KEEP_FIT.clearTiles.below9;
  let k = Math.min(KEEP_FIT.maxScale, (clear / 2) / Math.max(e.left, e.right));
  if (!g.citadel) k = Math.min(k, (K0 + KH - g.court[0]) / e.up); // below L9 it also stays under the courtyard top
  return k;
}
/** Keep draw scale (× true) at device px per deed d: kFit on d ≤ 280, true at d ≥ 1100, log-interpolated
 *  between (so on-screen size still grows monotonically, kFit < 3.9). Below the impostor band the keep
 *  is a marker icon, not a sprite; the scale there is kFit (the value the cross-fade starts from). */
export function keepScale(level, d) {
  const kf = kFit(level), a = KEEP_FIT.fitFromD, b = KEEP_FIT.trueAtD;
  if (d <= a) return kf;
  if (d >= b) return 1;
  return Math.pow(kf, 1 - Math.log(d / a) / Math.log(b / a));
}
/** The keep's ink rect (deed-local tiles) at a draw scale. */
export function keepInkRect(level, scale = 1) {
  const e = keepExtents(level), sy = K0 + KH;
  return { x0: C - e.left * scale, x1: C + e.right * scale, y0: sy - e.up * scale, y1: sy - e.down * scale };
}

// ---- sprite construction -------------------------------------------------------------------------------
const RUNTIME = { archer: 'archertower', alchemylab: 'forge' };
function scaleOf(fam) {
  if (fam === 'cannon' || fam === 'mortar') return ART_V2.buildingSourceScale[fam] / ART;
  if (fam === 'heroaltar' || fam === 'siegestool') return DECOR_LAYOUT.heroScale / ART;
  return WARE_WORLD_PRESENTATION[RUNTIME[fam] ?? fam].sourceScale / ART;
}
function footprintOf(fam) {
  const u = RUNTIME[fam] ?? fam;
  return (DEFENSES[u] ?? STRUCTURES[u]).footprint;
}
/** The game's own count cap for a decor family at keep level L (mines have their own Keep table;
 *  the alchemy lab is the runtime 'forge'). contracts.decorCap() then applies the presentation cap. */
export function decorCountCap(fam, L) {
  if (fam === 'mine') return MINING.MAX_MINES_BY_KEEP[L - 1];
  const arr = BUILD_COUNT_CAP_BY_KEEP[RUNTIME[fam] ?? fam];
  if (!arr) throw new Error(`decor: no build cap for ${fam}`);
  return arr[L - 1];
}
const offsetXOf = fam => (WARE_WORLD_PRESENTATION[RUNTIME[fam] ?? fam]?.offsetGamePx?.[0] ?? 0) / ART;

/** A game-v4 building instance on footprint (fx, fy). */
function gameSprite(fam, variant, fx, fy, role) {
  const key = `${fam}/${variant}`, a = GAME_ART[key];
  if (!a) throw new Error(`decor: no art for ${key}`);
  const [w, h, ax, ix0, iy0, ix1, iy1, frames, fps, rows] = a, [fw, fh] = footprintOf(fam);
  return { key, atlas: 'game', kind: 'building', role: role ?? fam, fam, fx, fy, fp: [fw, fh],
    tx: fx + fw / 2 + offsetXOf(fam), ty: fy + fh, z: fy + fh, anchor: [ax, h], scale: scaleOf(fam), cell: [w, h],
    ink: [ix0, iy0, ix1, iy1], rows, clip: frames > 1 ? { frames, ms: Math.round(1000 / fps) } : null, flipX: false, phase: 0 };
}
/** A realm-kit prop / creature instance on footprint (fx, fy); bottom-centre seat (realmKitPlacementSeat). */
function kitSprite(realm, id, fx, fy, kind, role, art = KIT_ART) {
  const a = art[realm]?.[id];
  if (!a) throw new Error(`decor: ${realm} kit has no measured '${id}'`);
  const [w, h, ix0, iy0, ix1, iy1, fw, fh, frames, ms] = a, creature = id.startsWith('creature:');
  const f = creature ? [1, 1] : [fw, fh];
  return { key: `kit:${id}`, atlas: creature ? 'creature' : 'kit', kind, role, fx, fy, fp: f,
    tx: fx + f[0] / 2, ty: fy + f[1], z: fy + f[1], anchor: [w / 2, h], scale: 1 / ART, cell: [w, h],
    ink: [ix0, iy0, ix1, iy1], rows: 1, clip: frames > 1 && !creature ? { frames, ms } : null, flipX: false, phase: 0 };
}
function wallSprite(tier, x, y, piece, ring) {
  const h = WALL_CELL_H[tier - 1];
  return { key: `wall5/t${tier}/${piece}`, atlas: 'wall', kind: 'wall', role: ring, fx: x, fy: y, fp: [1, 1],
    tx: x + 0.5, ty: y + 1, z: y + 1, anchor: [16, h], scale: 1 / ART, cell: [32, h], ink: [0, 0, 32, h], rows: 1, clip: null, flipX: false, phase: 0 };
}
/** Ink rect of an instance in deed-local tiles. */
export function inkRect(s, scale = 1) {
  const k = s.scale * scale, [ax, ay] = s.anchor;
  return { x0: s.tx + (s.ink[0] - ax) * k, y0: s.ty + (s.ink[1] - ay) * k, x1: s.tx + (s.ink[2] - ax) * k, y1: s.ty + (s.ink[3] - ay) * k };
}
/** Sky law (constants BUILDING_FIT, owner "nothing reaches it"): height below the keep's, and — for
 *  anything with mass — area below the keep's. Thin poles (banners, lamps; a flag is not mass) may reach
 *  poleSky × the keep's height; flat crop beds have no elevation at all. */
export function obeysSky(s, level) {
  const kr = keepInkRect(level), kh = kr.y1 - kr.y0, ka = kh * (kr.x1 - kr.x0), r = inkRect(s), h = r.y1 - r.y0, area = h * (r.x1 - r.x0);
  if (s.kind === 'flat') return true;                       // crop beds lie on the ground: no elevation, no mass
  if (s.kind === 'fence' || s.kind === 'edge') return h - (s.fp[1] - 1) < kh - 1e-9; // a 1×2 N–S rail's ink is depth, not height
  if (s.kind === 'pole') return h <= kh * DECOR_LAYOUT.poleSky + 1e-9;
  return h < kh - 1e-9 && area < ka;
}

// ---- hashing (integer, deterministic; the kit's realmKitTileHash shape) ----------------------------------
export function hash2(a, b) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ 0x5bd1e995) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}
/** A base's decor seed from its id (number or string). formation = seed % 4. */
export function seedOf(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return hash2(id | 0, 7331);
  let h = 2166136261; for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return hash2(h, 7331);
}

// ---- the composer --------------------------------------------------------------------------------------
const Z = { NONE: 0, RING: 1, SKIRT: 2, YARD: 3, COURT: 4, WALL: 5, EDGE: 6, LANE: 7, OCC: 8, KEEP: 9 };
const cache = new Map();

/**
 * composeBaseDecor({ level, realmId, seed, keepFootprint, claimTiles, kit }) →
 *   { level, realmId, formation, geometry, claim, plot, keep, walls:[{tier,x,y,piece,ring}],
 *     edges:[{style,x,y,piece}], sprites:[instance], emitters:[{kind,tx,ty,dx,dy,attach?,r?,a?}], omitted:[role] }
 * `sprites` holds every decor sprite (buildings, dressing, poles, creatures, torch fire) — never the keep
 * (bases.js draws the live keep) and never walls or edges (their own lists). Throws when a building
 * cannot be placed or the wall count passes wallCapForKeepLevel: a silent drop would be a lie.
 */
export function composeBaseDecor({ level, realmId, seed = 0, keepFootprint = KEEP_FOOTPRINT, claimTiles, kit, gates } = {}) {
  if (keepFootprint[0] !== KW || keepFootprint[1] !== KH) throw new Error('decor: keep footprint v2 needs the 8×8 citadel (plan §6.3)');
  if (!KIT_DRESSING[realmId]) throw new Error(`decor: no kit dressing for realm '${realmId}'`);   // the dressing is the gate, not SHELL's list
  const L = rule(level).level, formation = (seed >>> 0) % 4;
  const ck = `${realmId}|${L}|${formation}|${claimTiles ?? ''}|${kit ? 'k' : ''}`;
  let base = kit ? null : cache.get(ck);
  if (!base) { base = layout(L, realmId, formation, claimTiles, kit); if (!kit) cache.set(ck, base); }
  // The kingdom (walls, buildings, fixtures) depends on the formation only; the tended land around it (fields,
  // pens, orchards, camp, wild scatter, hedges, lanes) on the whole seed, so no two neighbours farm alike.
  // gates: the sides a road leaves by — only the sides a path to a neighbour takes (fix iteration 2, QA 3: "stubs end
  // in open grass"): a lane always ends on a path, never in the open; a kingdom with no link has no lane out
  const gateSet = new Set((gates ?? []).filter(sd => GATE_SIDES.includes(sd)));
  const ring = ringLayout(L, realmId, seed >>> 0, base.geometry, base.art, base.dress, gateSet);
  const all = [...base.sprites, ...ring.sprites];
  const sprites = all.map((s, i) => (s.clip ? { ...s, phase: hash2(seed >>> 0, i) % s.clip.frames } : s));
  const emitters = [...base.emitters];
  for (const s of sprites) if (s.role === 'brazier' || s.role === 'campfire' || s.role === 'light') {
    const r = inkRect(s); emitters.push({ kind: 'glow', tx: (r.x0 + r.x1) / 2, ty: r.y0 + 0.25, dx: 0, dy: 0, r: DECOR_LAYOUT.glow.r / ART, a: DECOR_LAYOUT.glow.a * 0.8 });
  }
  const { art, dress, ...rest } = base;
  return { ...rest, seed: seed >>> 0, sprites, emitters, edges: ring.edges, ground: ring.ground, lanes: ring.lanes, laneEnds: ring.laneEnds, gates: [...gateSet], patches: ring.patches, omitted: [...base.omitted, ...ring.omitted] };
}

function layout(L, realmId, formation, claimTiles, kit) {
  const g = plotGeometry(L, claimTiles), band = decorBand(L), tier = g.wallTier;
  const art = kit?.art ? { ...KIT_ART, [realmId]: { ...KIT_ART[realmId], ...kit.art } } : KIT_ART;
  const dress = kit?.dressing ? { ...KIT_DRESSING[realmId], ...kit.dressing } : KIT_DRESSING[realmId];
  const N = TILES, grid = new Uint8Array(N * N), at = (x, y) => grid[y * N + x];
  const set = (x, y, v) => { grid[y * N + x] = v; };
  // zones
  for (let y = g.P0; y < g.P1; y++) for (let x = g.P0; x < g.P1; x++) {
    let z = Z.RING;
    if (x === g.P0 || y === g.P0 || x === g.P1 - 1 || y === g.P1 - 1) z = Z.EDGE;
    if (x >= g.A && x < g.B && y >= g.A && y < g.B) z = Z.SKIRT;
    if (x > g.o0 && x < g.o1 && y > g.o0 && y < g.o1) z = Z.YARD;
    const onRing = (a, b) => (x === a || x === b || y === a || y === b) && x >= a && x <= b && y >= a && y <= b;
    if (onRing(g.o0, g.o1) || (g.doubled && onRing(g.o0 + 1, g.o1 - 1)) || (g.citadel && onRing(g.citadel[0], g.citadel[1]))) z = Z.WALL;
    if (x >= g.court[0] && x < g.court[1] && y >= g.court[0] && y < g.court[1]) z = Z.COURT;
    if (x >= K0 && x < K0 + KW && y >= K0 && y < K0 + KH) z = Z.KEEP;
    else if (z !== Z.COURT && isLane(g, x, y)) z = Z.LANE;
    set(x, y, z);
  }
  // walls (formation-invariant)
  const walls = [];
  const addRing = (cells, ring) => { for (const [x, y, piece] of resolvePieces(cells)) walls.push({ tier, x, y, piece, ring }); };
  const notLane = ([x, y]) => at(x, y) !== Z.LANE;
  if (g.wallRings >= 1) addRing(ringWalk(g.o0, g.o1).filter(notLane), 'outer');
  if (g.doubled) addRing(ringWalk(g.o0 + 1, g.o1 - 1).filter(notLane), 'inner');
  if (g.citadel) addRing(ringWalk(g.citadel[0], g.citadel[1]).filter(notLane), 'citadel');
  if (g.wallRings === 0) addRing([[K0 - 2, g.o1], [K0 - 1, g.o1], [K0 + KW, g.o1], [K0 + KW + 1, g.o1]], 'stub'); // L1 palisade stub
  const wallCap = wallCapForKeepLevel(L);
  if (walls.length > wallCap) throw new Error(`decor L${L}: ${walls.length} wall pieces exceed the keep cap ${wallCap}`);

  const sprites = [], omitted = [], emitters = [];
  const occupy = (fx, fy, fw, fh) => { for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) set(x, y, Z.OCC); };
  const fits = (fx, fy, fw, fh, zones) => {
    if (fx < g.P0 || fy < g.P0 || fx + fw > g.P1 || fy + fh > g.P1) return false;
    for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) if (!zones.includes(at(x, y))) return false;
    return true;
  };
  /** Nearest free footprint to a continuous anchor centre (deterministic: first minimum in row order). */
  const find = (fw, fh, ax, ay, zones) => {
    let best = null, bd = Infinity;
    for (let fy = g.P0; fy + fh <= g.P1; fy++) for (let fx = g.P0; fx + fw <= g.P1; fx++) {
      const d = (fx + fw / 2 - ax) ** 2 + (fy + fh / 2 - ay) ** 2;
      if (d < bd && fits(fx, fy, fw, fh, zones)) { bd = d; best = [fx, fy]; }
    }
    return best;
  };
  /** Formation transform of a slot anchor (bit 0 mirrors x, bit 1 rotates 180° about the deed centre).
   *  Sprites stay upright and unflipped: 3/4-view art is lit from the upper left (house style). */
  const T = (x, y) => {
    let X = x, Y = y;
    if (formation & 1) X = 2 * C - X;
    if (formation & 2) { X = 2 * C - X; Y = 2 * C - Y; }
    return [X, Y];
  };
  const keepLevelSky = s => obeysSky(s, L);
  const placeBuilding = (fam, variant, ax, ay, zones) => {
    const [fw, fh] = footprintOf(fam), [X, Y] = T(ax, ay), p = find(fw, fh, X, Y, zones);
    if (!p) throw new Error(`decor L${L} ${realmId} f${formation}: no room for ${fam}`);
    const s = gameSprite(fam, variant, p[0], p[1]);
    if (!keepLevelSky(s)) throw new Error(`decor L${L}: ${fam}/${variant} breaks the keep's sky law`);
    occupy(p[0], p[1], fw, fh); sprites.push(s); return s;
  };
  /** Place a kit dressing role at a slot anchor; candidates are tried in order against the sky law. */
  const placeKit = (role, ax, ay, zones, pick = 0, kind = 'dressing', fixed = false) => {
    const list = dress[role] ?? [];
    const ids = Array.isArray(list) ? [...list.slice(pick % Math.max(1, list.length)), ...list.slice(0, pick % Math.max(1, list.length))] : [list];
    for (const id of ids) {
      const probe = kitSprite(realmId, id, 0, 0, kindOfRole(role, kind), role, art);
      if (!keepLevelSky(probe)) continue;
      const [fw, fh] = probe.fp, [X, Y] = fixed ? [ax, ay] : T(ax, ay);
      const p = fixed ? (fits(Math.floor(X), Math.floor(Y), fw, fh, zones) ? [Math.floor(X), Math.floor(Y)] : null) : find(fw, fh, X, Y, zones);
      if (!p) continue;
      const s = kitSprite(realmId, id, p[0], p[1], probe.kind, role, art);
      occupy(p[0], p[1], fw, fh); sprites.push(s); return s;
    }
    omitted.push(role); return null;
  };

  // ---- fixtures (formation-invariant: attached to the walls and gates) -------------------------------
  const FREE = [Z.RING, Z.SKIRT, Z.YARD];
  const Lc = K0 - 1, Rc = K0 + KW;                              // gate cheek columns/rows: 47, 50
  const cheeksOut = { S: [[Lc, g.o1 + 1], [Rc, g.o1 + 1]], N: [[Lc, g.o0 - 1], [Rc, g.o0 - 1]], W: [[g.o0 - 1, Lc], [g.o0 - 1, Rc]], E: [[g.o1 + 1, Lc], [g.o1 + 1, Rc]] };
  const cheeksIn = { S: [[Lc, g.wInHi], [Rc, g.wInHi]], N: [[Lc, g.wIn], [Rc, g.wIn]], W: [[g.wIn, Lc], [g.wIn, Rc]], E: [[g.wInHi, Lc], [g.wInHi, Rc]] };
  const fixture = (role, [x, y]) => placeKit(role, x, y, FREE, 0, 'dressing', true);
  fixture('banner', cheeksOut.S[1]);
  if (band >= 1 && L >= 3) fixture('banner', cheeksOut.S[0]);
  if (band >= 2) {
    for (const side of ['N', 'E', 'W']) { fixture('banner', cheeksOut[side][1]); fixture(band >= 5 ? 'banner' : 'light', cheeksOut[side][0]); }
    for (const c of cheeksIn.S) fixture('light', c);
  }
  if (band >= 3) {
    const [a, b] = g.citadel;
    for (const c of [[a - 1, a - 1], [b + 1, a - 1], [a - 1, b + 1], [b + 1, b + 1]]) fixture('brazier', c);
    for (const c of [[g.o0 - 1, g.o0 - 1], [g.o1 + 1, g.o0 - 1], [g.o0 - 1, g.o1 + 1], [g.o1 + 1, g.o1 + 1]]) fixture('banner', c);
  }
  if (band >= 5) {
    for (const side of ['N', 'E', 'W']) for (const c of cheeksIn[side]) fixture('light', c);
    for (const c of [[g.wIn, g.wIn], [g.wInHi, g.wIn], [g.wIn, g.wInHi], [g.wInHi, g.wInHi]]) fixture('brazier', c);
  }
  if (band >= 4) { // torches on the outer ring's gate-cheek pieces (legacy-fx_fire + additive glow)
    const topPx = WALL_CELL_H[tier - 1] - 12;                   // wall crest, px above the tile's south edge
    for (const w of walls) if (w.ring === 'outer' && w.piece.startsWith('end_')) {
      const s = { key: 'fx/fire', atlas: 'fx', kind: 'fx', role: 'torch', fx: w.x, fy: w.y, fp: [0, 0], tx: w.x + 0.5, ty: w.y + 1 - topPx / ART,
        z: w.y + 1 + 0.01, anchor: [8, 24], scale: 1 / ART, cell: FIRE.cell, ink: FIRE.ink, rows: 1, clip: { frames: FIRE.frames, ms: FIRE.ms }, flipX: false, phase: 0 };
      sprites.push(s);
      emitters.push({ kind: 'glow', tx: s.tx, ty: s.ty - 0.4, dx: 0, dy: 0, r: DECOR_LAYOUT.glow.r / ART, a: DECOR_LAYOUT.glow.a });
    }
  }

  // ---- buildings (slot-placed; formation moves them) ----------------------------------------------------
  const s0 = g.A + 1, s1 = g.B - 1, q = g.S / 4 + 1;           // skirt band centres, side offset
  const m0 = (g.wIn + (g.citadel ? g.citadel[0] : g.court[0])) / 2;              // yard band centres
  const m1 = ((g.citadel ? g.citadel[1] + 1 : g.court[1]) + g.wInHi + 1) / 2;
  const tt = `t${towerTier(L)}`;
  const count = fam => Math.min(decorCountCap(fam, L), decorCap(fam, L));
  const yard = [Z.YARD], skirt = [Z.SKIRT];
  // yard 2×2 first (the band is 1 wide below L3, where none unlock), then 1×1 towers
  const yardBig = [
    ['goldforge', `l${L}`, [[m0, C + 2]]], ['heroaltar', 'base', [[C - 2, m0]]], ['siegestool', 'base', [[C + 2, m0]]],
    ['clanhall', tt, [[C + 2, m1]]], ['mortar', tt, [[m1, m0], [m0, m1]]], ['airdefence', tt, [[m1, C - 2], [m0, C - 2]]],
    ['dragonnest', tt, [[m1, C + 2]]],
  ];
  const yardSmall = [
    ['lasertower', tt, [[m1, m1], [m0, m0]]], ['magetower', tt, [[C - 2, m1], [m1, m0]]], ['electrictower', tt, [[m0, m1], [C + 2, m0]]],
    ['archer', tt, [[m0, m0], [m1, m0], [m0, C + 2], [m1, C - 2]]], ['cannon', tt, [[m1, m1], [m0, m1], [C + 2, m1], [C - 2, m0]]],
  ];
  const skirtItems = [
    ['camp', tt, [[C - q, s1], [C + q, s0]]], ['barracks', tt, [[C + q, s1]]], ['vault', tt, [[s0, C - q], [s1, C + q]]],
    ['mine', tt, [[s1, C - q], [s0, C + q], [s0, s0], [s1, s1]]], ['alchemylab', tt, [[C - q, s0]]],
  ];
  for (const [fam, v, anchors] of [...yardBig, ...yardSmall]) {
    const n = count(fam);
    for (let i = 0; i < n; i++) { const [ax, ay] = anchors[i % anchors.length]; placeBuilding(fam, v, ax, ay, yard); }
  }
  for (const [fam, v, anchors] of skirtItems) {
    const n = count(fam);
    for (let i = 0; i < n; i++) { const [ax, ay] = anchors[i % anchors.length]; placeBuilding(fam, v, ax, ay, skirt); }
  }

  // ---- emitters: keep smoke, alchemy-lab chimney, keep pennants (attached to the keep's kFit scale) ---------
  const kr = keepInkRect(L), kw = kr.x1 - kr.x0, kh = kr.y1 - kr.y0, nSmoke = DECOR_LAYOUT.smokeByBand[band];
  const smokeX = [-0.26, 0.26, 0];
  for (let i = 0; i < nSmoke; i++) emitters.push({ kind: 'smoke', attach: 'keep', tx: C + smokeX[i] * kw, ty: kr.y0 + kh * (i < 2 ? 0.42 : 0.1), dx: 0, dy: 0 });
  for (const s of sprites) if (s.fam === 'alchemylab') { const r = inkRect(s); emitters.push({ kind: 'smoke', tx: (r.x0 + r.x1) / 2 + 0.15, ty: r.y0 + 0.1, dx: 0, dy: 0 }); }
  const tips = KEEP_TIPS[L - 1], kk = scaleOf('keep'), [, kch, kax] = keepArt(L);
  const pick = L >= 9 ? tips : [tips[0], tips[tips.length - 1]];
  for (const [px, py] of pick) emitters.push({ kind: 'pennant', attach: 'keep', tx: C + (px - kax) * kk, ty: K0 + KH + (py - kch) * kk, dx: 0, dy: 0 });

  const keep = { key: `keep/l${L}`, atlas: 'game', kind: 'keep', tx: C, ty: K0 + KH, z: K0 + KH, anchor: [keepArt(L)[2], keepArt(L)[1]],
    scale: scaleOf('keep'), cell: [keepArt(L)[0], keepArt(L)[1]], ink: keepArt(L).slice(3, 7), clip: { frames: 3, ms: 83 }, fp: [KW, KH], fx: K0, fy: K0 };
  const claim = { x0: g.A, y0: g.A, x1: g.B, y1: g.B, S: g.S }, plot = { x0: g.P0, y0: g.P0, x1: g.P1, y1: g.P1, ring: g.ring };
  const freeze = o => Object.freeze(o);
  return freeze({ level: L, realmId, formation, geometry: freeze(g), claim, plot, keep, walls, sprites, emitters, omitted, art, dress });
}

// ---- the tended ring (round 2, T3: "bases fit naturally in the map world") -------------------------------
// The ring between the claim and the plot edge is the kingdom's farmland, laid out per BASE (the whole seed, not
// just the formation), so neighbours never farm alike: organic field patches of varied crops (hedged from L8),
// fenced pens with livestock, orchards, a camp, and the realm's own wild scatter thickening toward the plot edge
// so the base melts into LIFE's wilderness instead of sitting in a pasted box. No closed fence around the plot:
// every hedge and fence follows a patch. Everything is pure, deterministic and integer-seated like the rest.
/** Kit 'decal' props (flat, no elevation): the sky law does not apply, like crop beds. */
export const DECALS = Object.freeze(new Set(['desert_flowers', 'rock_s_sand', 'stump_palm', 'rock_s_frost', 'stump_snow', 'snow_mound', 'rock_s_basalt',
  'obsidian_pile_low', 'flowers', 'rock_s', 'dry_grass', 'mushrooms', 'stump', 'log', 'rock_s_granite',
  'rock_s_jungle', 'mud_wallow', 'rock_s_slate', 'rock_s_slate_b']));   // Stage B: the kits' own 'decal' props
const u01 = (a, b) => hash2(a, b) / 4294967296;
const PATH_LO = LANES[0] - 1, PATH_HI = LANES[LANES.length - 1] + 1;   // 47, 50: a straight lane's shoulders
export const GATE_SIDES = Object.freeze(['N', 'S', 'W', 'E']);
/** The kingdom's favoured side (fix iteration 1: not every base leaves south, so the MAP band is not a sea of one
 *  template). Fix iteration 2: it only biases where the ring's patches go; a lane is laid only on a side a path to a
 *  neighbour takes (bases.js `gates`), so no lane ends in open land. */
export function mainGate(seed) { const u = u01(seed >>> 0, 0x6a7e); return u < 0.4 ? 'S' : u < 0.6 ? 'N' : u < 0.8 ? 'W' : 'E'; }
/** How a lane runs through the ring: `at(t)` is the lateral shift at outward row t (0 = the row against the claim),
 *  `end` the shift where the lane meets the plot edge (basePaths leaves from there). Fix iteration 2 (QA 3: "roads jog
 *  where they meet the gate — two offset pieces"): a lane runs STRAIGHT on its gate axis (the keep's columns) from the
 *  wall gate to the plot edge; the path to the neighbour curves away from there (basePaths' Bézier leaves along the
 *  side's normal), so the road reads as one piece. Kept as a function so basePaths and the tests share one rule. */
export function laneMeander(seed, side, ring) {
  void seed; void side; void ring;
  return { at: () => 0, end: 0 };
}
/** A laned side's cells: the ring part (meandering, 2 wide, 4-connected since each step moves one column) and the
 *  claim part (straight on the keep's columns, through the wall gates to the courtyard or the citadel). */
function laneCells(g, side, seed) {
  const m = laneMeander(seed, side, g.ring), ring = [], claim = [], ns = side === 'N' || side === 'S';
  for (let t = 0; t < g.ring; t++) {
    const sh = m.at(t), o = side === 'N' || side === 'W' ? g.A - 1 - t : g.B + t;
    for (const v of LANES) ring.push(ns ? [v + sh, o] : [o, v + sh]);
  }
  const cit = g.citadel, top = cit ? cit[0] : g.court[0], bot = cit ? cit[1] + 1 : g.court[1];
  for (const v of LANES) {
    if (side === 'N') for (let y = g.A; y < top; y++) claim.push([v, y]);
    if (side === 'S') for (let y = bot; y < g.B; y++) claim.push([v, y]);
    if (side === 'W') for (let x = g.A; x < top; x++) claim.push([x, v]);
    if (side === 'E') for (let x = bot; x < g.B; x++) claim.push([x, v]);
  }
  return { ring, claim, end: m.end };
}
/** Fields per base (T3 fix 2: never the same four corners): a per-seed count whose range grows with the ladder. */
export function fieldCount(L, seed) {
  const [lo, hi] = L <= 1 ? [1, 2] : L <= 5 ? [1, 3] : L <= 11 ? [2, 3] : L <= 16 ? [2, 4] : [3, 4];
  return lo + Math.min(hi - lo, Math.floor(u01(seed >>> 0, 0xf1e1d) * (hi - lo + 1)));
}
/** The ring's slots: its four bands (N and S keep the corners; W and E sit between them with a free row either side,
 *  so no two patches touch), split where a lane leaves, then cut into 1–3 slots with a wild gap between. Which slots
 *  are farmed is chosen per seed, so every kingdom leaves some of its land wild, and differently. */
export function ringSlots(g, gates, laneOf, seed) {
  const bands = [
    { side: 'N', along: 'x', a0: g.P0, a1: g.P1 - 1, c0: g.P0, c1: g.A - 1 },
    { side: 'S', along: 'x', a0: g.P0, a1: g.P1 - 1, c0: g.B, c1: g.P1 - 1 },
    { side: 'W', along: 'y', a0: g.A + 1, a1: g.B - 2, c0: g.P0, c1: g.A - 1 },
    { side: 'E', along: 'y', a0: g.A + 1, a1: g.B - 2, c0: g.B, c1: g.P1 - 1 },
  ];
  const slots = [];
  for (const b of bands) {
    let parts = [[b.a0, b.a1]];
    if (gates.has(b.side)) {
      const across = laneOf[b.side].ring.map(([x, y]) => (b.along === 'x' ? x : y));
      parts = [[b.a0, Math.min(...across) - 2], [Math.max(...across) + 2, b.a1]];
    }
    parts.forEach(([p0, p1], pi) => {
      const len = p1 - p0 + 1, h = hash2(seed, 5000 + GATE_SIDES.indexOf(b.side) * 7 + pi);
      if (len < 3) return;
      const n = len >= 30 ? 2 + (u01(h, 1) < 0.35 ? 1 : 0) : len >= 15 ? 1 + (u01(h, 1) < 0.6 ? 1 : 0) : 1;
      let s0 = p0;
      for (let i = 0; i < n && p1 - s0 + 1 >= 4; i++) {
        const remain = p1 - s0 + 1, want = i === n - 1 ? remain : Math.round((remain / (n - i)) * (0.7 + 0.6 * u01(h, 10 + i)));
        const s1 = Math.min(p1, s0 + Math.max(4, want) - 1);
        slots.push(b.along === 'x' ? { id: `${b.side}${pi}${i}`, side: b.side, along: 'x', x0: s0, x1: s1, y0: b.c0, y1: b.c1 }
          : { id: `${b.side}${pi}${i}`, side: b.side, along: 'y', x0: b.c0, x1: b.c1, y0: s0, y1: s1 });
        s0 = s1 + 2 + (hash2(h, 20 + i) % 2);                                    // a wild gap of 1–2 tiles
      }
    });
  }
  return slots;
}
/** What the base farms, in priority order (the ladder reads as growth: a founding camp and one or two open plots at
 *  L1; a fenced pen from L6; an orchard from L10; a farmyard from L12; a second orchard from L17; the field count
 *  itself varies per seed inside a range that grows with the level). */
export function ringWants(L, seed) {
  const want = ['camp', 'field'], nF = fieldCount(L, seed);
  if (L >= DECOR_LAYOUT.penFrom) want.push('pen');
  if (L >= DECOR_LAYOUT.orchardFrom) want.push('orchard');
  for (let i = 1; i < nF; i++) want.push('field');
  if (L >= DECOR_LAYOUT.farmFrom) want.push('yard');
  if (L >= DECOR_LAYOUT.orchard2From) want.push('orchard');
  return want;
}
/** Cells of an organic patch in a slot (T3 fix 2: never a notched rectangle). `convex` (hedged fields, pens): one
 *  wobbling ellipse — convex, so the hedge round it is always one clean loop. Otherwise (open fields, camps, yards,
 *  orchards): a union of 1–3 jittered ellipses strung along the slot, so a long field bends and swells like land
 *  worked by hand, its corners bitten until it fills ≤ 84 % of its box. Both are opened (no one-tile spurs), the
 *  largest 4-connected part kept and the box corners cut. `maxLen` crops a sub-slot first (a camp is compact). */
function patchCells(slot, h, free, fill = 1, maxLen = Infinity, convex = false) {
  const ax = slot.along === 'x';
  let A0 = ax ? slot.x0 : slot.y0, A1 = ax ? slot.x1 : slot.y1;
  const C0 = ax ? slot.y0 : slot.x0, C1 = ax ? slot.y1 : slot.x1, wid = C1 - C0 + 1;
  if (A1 - A0 + 1 > maxLen) { const st = A0 + Math.floor(u01(h, 29) * (A1 - A0 + 2 - maxLen)); A0 = st; A1 = st + maxLen - 1; }
  const len = A1 - A0 + 1;
  if (len < 3 || wid < 2) return [];
  const blobs = [];
  if (convex) blobs.push([A0 + len / 2 + (u01(h, 30) - 0.5) * len * 0.1, C0 + wid / 2, Math.max(1.5, (len / 2) * fill), Math.max(1.3, (wid / 2) * fill), u01(h, 70) * 6.2832, 0.07, 2.3]);
  else {
    const n = len >= 18 ? 3 : len >= 9 ? 2 : 1;
    for (let i = 0; i < n; i++) blobs.push([A0 + ((i + 0.5) * len) / n + (u01(h, 30 + i) - 0.5) * (len / n) * 0.5, C0 + wid / 2 + (u01(h, 40 + i) - 0.5) * wid * 0.35,
      Math.max(1.3, (len / n / 2) * (0.9 + 0.45 * u01(h, 50 + i)) * fill), Math.max(1.1, (wid / 2) * (0.62 + 0.38 * u01(h, 60 + i)) * fill), u01(h, 70 + i) * 6.2832, 0.16, 2]);
  }
  let set = new Set();
  for (let a = A0; a <= A1; a++) for (let c = C0; c <= C1; c++) {
    const x = ax ? a : c, y = ax ? c : a;
    if (!free(x, y)) continue;
    for (const [ca, cc, ra, rc, ph, wob, P] of blobs) {
      const da = (a + 0.5 - ca) / ra, dc = (c + 0.5 - cc) / rc, th = Math.atan2(dc, da);
      if (Math.abs(da) ** P + Math.abs(dc) ** P < 1 + wob * Math.sin(3 * th + ph)) { set.add(y * TILES + x); break; }
    }
  }
  const boxOf = st => { const X = [...st].map(k => k % TILES), Y = [...st].map(k => (k / TILES) | 0); return [Math.min(...X), Math.max(...X), Math.min(...Y), Math.max(...Y)]; };
  if (!convex && set.size > 6) {                          // bite round corners (before the opening: clean outline)
    const [bx0, bx1, by0, by1] = boxOf(set), cs = [[bx0, by0], [bx1 + 1, by0], [bx0, by1 + 1], [bx1 + 1, by1 + 1]].sort((p, q) => hash2(h, p[0] * 131 + p[1]) - hash2(h, q[0] * 131 + q[1]));
    for (let r = 1.6, i = 0; set.size > 6 && r < 6; i = (i + 1) % 4, r += i === 0 ? 0.6 : 0) {
      const [a0, a1, b0, b1] = boxOf(set); if (set.size <= (a1 - a0 + 1) * (b1 - b0 + 1) * 0.84) break;
      const [qx, qy] = cs[i]; for (const k of [...set]) if (Math.hypot((k % TILES) + 0.5 - qx, ((k / TILES) | 0) + 0.5 - qy) < r) set.delete(k);
    }
  }
  const n4 = k => [k - 1, k + 1, k - TILES, k + TILES];
  const core = new Set([...set].filter(k => n4(k).every(m => set.has(m))));
  const opened = new Set([...set].filter(k => core.has(k) || n4(k).some(m => core.has(m))));
  let best = [];
  const seen = new Set();
  for (const k of [...opened].sort((p, q) => p - q)) {
    if (seen.has(k)) continue;
    const comp = [], st = [k]; seen.add(k);
    while (st.length) { const c = st.pop(); comp.push(c); for (const m of n4(c)) if (opened.has(m) && !seen.has(m) && Math.abs((m % TILES) - (c % TILES)) <= 1) { seen.add(m); st.push(m); } }
    if (comp.length > best.length) best = comp;
  }
  if (best.length) {            // never a box: the patch's own bounding-box corners are always cut
    const [bx0, bx1, by0, by1] = boxOf(best), corner = new Set([by0 * TILES + bx0, by0 * TILES + bx1, by1 * TILES + bx0, by1 * TILES + bx1]);
    best = best.filter(k => !corner.has(k));
  }
  return best.sort((p, q) => p - q);
}
/** A slot's score for a use (higher wins; < 0 unusable). Fields and pens want room, the camp sits by the main
 *  road, and a seeded jitter keeps two kingdoms of one level from choosing alike. */
function slotScore(use, slot, main, h) {
  const area = (slot.x1 - slot.x0 + 1) * (slot.y1 - slot.y0 + 1), j = u01(h, 1);
  if (use === 'camp') return (slot.side === main ? 2 : 1) * (0.6 + 0.8 * j) / (1 + Math.abs(area - 40) / 40);
  if (use === 'pen') return area >= 20 ? Math.min(area, 60) * (0.5 + j) : -1;
  if (use === 'yard') return area >= 12 ? Math.min(area, 50) * (0.5 + j) : -1;
  if (use === 'orchard') return area >= 12 ? area * (0.4 + j) : -1;
  return area >= 10 ? area * (0.45 + j) : -1;                                     // field
}

function ringLayout(L, realmId, seed, g, art, dress, gates) {
  const N = TILES, occ = new Uint8Array(N * N), band = decorBand(L);
  const inClaim = (x, y) => x >= g.A && x < g.B && y >= g.A && y < g.B;
  const inPlot = (x, y) => x >= g.P0 && y >= g.P0 && x < g.P1 && y < g.P1;
  // the laned sides only (fix iteration 1): a side without a road is farmed or left wild right across its gate axis
  const laneOf = {}, road = new Uint8Array(N * N);
  for (const side of GATE_SIDES) if (gates.has(side)) {
    const l = laneOf[side] = laneCells(g, side, seed), ns = side === "N" || side === "S";
    for (const [x, y] of l.ring) for (const d of [-1, 0, 1]) road[(ns ? y : y + d) * N + (ns ? x + d : x)] = 1;   // lane + shoulders
  }
  const corridor = (x, y) => road[y * N + x] === 1;
  const free = (x, y) => inPlot(x, y) && !inClaim(x, y) && !corridor(x, y) && !occ[y * N + x];
  const fits = (fx, fy, fw, fh, allow = free) => { for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) if (!allow(x, y)) return false; return true; };
  const take = (fx, fy, fw, fh) => { for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) occ[y * N + x] = 1; };
  const sprites = [], edges = [], ground = [], patches = [], omitted = [];
  const sky = s => DECALS.has(s.key.slice(4)) || obeysSky(s, L);
  const kindOf = (id, role) => (DECALS.has(id) || isFlatCrop(id) ? 'flat' : kindOfRole(role, 'dressing'));
  const put = (id, fx, fy, role, { jx = 0, jy = 0, kind } = {}) => {
    const s = kitSprite(realmId, id, fx, fy, kind ?? kindOf(id, role), role, art);
    if (jx || jy) { s.tx += jx; s.ty += jy; s.z = s.ty; }
    take(fx, fy, s.fp[0], s.fp[1]); sprites.push(s); return s;
  };
  const probe = (id, role) => kitSprite(realmId, id, 0, 0, kindOf(id, role), role, art);
  /** First candidate of a role (rotated by pick) that obeys the sky law and fits nearest (ax, ay) inside `allow`. */
  const placeNear = (role, ax, ay, allow, pick = 0, opts = {}, again = true) => {
    const list = dress[role] ?? [], n = list.length;
    for (let j = 0; j < n; j++) {
      const id = list[(pick + j) % n], pr = probe(id, role);
      if (!sky(pr)) continue;
      const [fw, fh] = pr.fp;
      let best = null, bd = Infinity;
      for (let fy = g.P0; fy + fh <= g.P1; fy++) for (let fx = g.P0; fx + fw <= g.P1; fx++) {
        const d = (fx + fw / 2 - ax) ** 2 + (fy + fh / 2 - ay) ** 2;
        if (d < bd && fits(fx, fy, fw, fh, allow)) { bd = d; best = [fx, fy]; }
      }
      if (best) return put(id, best[0], best[1], role, opts);
    }
    if (again && allow !== free) return placeNear(role, ax, ay, free, pick, opts, false);   // spill just outside its patch
    omitted.push(role); return null;
  };
  const inSet = set => (x, y) => set.has(y * N + x) && free(x, y);
  /** A patch's hedge / fence loop (8-neighbour outline, so it is 4-connected), with one gate toward the path. */
  const outlineOf = (cells, set) => {
    const out = new Set(cells.filter(k => { const x = k % N, y = (k / N) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && !set.has((y + dy) * N + x + dx)) return true; return false; }));
    for (let changed = true; changed;) {                  // prune spurs: a loop cell needs two loop neighbours
      changed = false;
      for (const k of [...out]) if ([k - 1, k + 1, k - N, k + N].filter(n => out.has(n)).length < 2) { out.delete(k); changed = true; }
    }
    return [...out].sort((a, b) => a - b);
  };
  /** A fenced patch needs a simple outline loop (every loop tile has exactly two loop neighbours, no patch tile left
   *  outside it): trim the tiles that break it (thick staircase corners, spurs), keep the largest part, repeat; null
   *  when it cannot be fenced cleanly. */
  const fenceable = cells0 => {
    let cells = cells0;
    for (let it = 0; it < 8 && cells.length >= 8; it++) {
      const set = new Set(cells), on = new Set(outlineOf(cells, set)), n4 = k => [k - 1, k + 1, k - N, k + N];
      const drop = cells.filter(k => (on.has(k) ? n4(k).filter(m => on.has(m)).length !== 2
        : [-N - 1, -N, -N + 1, -1, 1, N - 1, N, N + 1].some(o => !set.has(k + o))));
      if (!drop.length) return cells;
      const dropS = new Set(drop), rest = new Set(cells.filter(k => !dropS.has(k))), seen = new Set();
      let best = [];
      for (const k of [...rest].sort((p, q) => p - q)) {
        if (seen.has(k)) continue;
        const comp = [], st = [k]; seen.add(k);
        while (st.length) { const c = st.pop(); comp.push(c); for (const m of n4(c)) if (rest.has(m) && !seen.has(m)) { seen.add(m); st.push(m); } }
        if (comp.length > best.length) best = comp;
      }
      cells = best.sort((p, q) => p - q);
    }
    return null;
  };
  const addLoop = (loop, gateTo, style, id) => {
    const on = new Set(loop);
    let gi = -1, gd = Infinity;                           // the gate: a straight run's tile nearest the road
    loop.forEach((k, i) => {
      const ew = on.has(k - 1) && on.has(k + 1) && !on.has(k - N) && !on.has(k + N), ns = on.has(k - N) && on.has(k + N) && !on.has(k - 1) && !on.has(k + 1);
      if (!ew && !ns) return;
      const d = ((k % N) + 0.5 - gateTo[0]) ** 2 + (((k / N) | 0) + 0.5 - gateTo[1]) ** 2; if (d < gd) { gd = d; gi = i; } });
    const cells = loop.filter((_, i) => i !== gi).map(k => [k % N, (k / N) | 0]);
    for (const [x, y, piece, mask] of resolvePieces(cells)) { edges.push({ style, x, y, piece, mask, loop: id }); occ[y * N + x] = 1; }
  };
  // a patch's hedge gate faces the nearest lane when one runs close by, else the kingdom (the claim edge)
  const laneTiles = Object.values(laneOf).flatMap(l => l.ring);
  const gateTarget = cells => {
    const cx = cells.reduce((a, k) => a + (k % N), 0) / cells.length + 0.5, cy = cells.reduce((a, k) => a + ((k / N) | 0), 0) / cells.length + 0.5;
    let best = null, bd = 144;
    for (const [x, y] of laneTiles) { const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2; if (d < bd) { bd = d; best = [x + 0.5, y + 0.5]; } }
    return best ?? [Math.min(Math.max(cx, g.A), g.B), Math.min(Math.max(cy, g.A), g.B)];
  };
  const centroid = cells => [cells.reduce((a, k) => a + (k % N), 0) / cells.length + 0.5, cells.reduce((a, k) => a + ((k / N) | 0), 0) / cells.length + 0.5];
  // choose the slots: each wanted patch takes the best-scoring free slot (per-seed jitter); the rest stay wild
  const main = mainGate(seed), slots = ringSlots(g, gates, laneOf, seed), uses = {}, plan = [];
  const cropOrder = (dress.crops ?? []).map((id, i) => [hash2(seed, 700 + i), id]).sort((a, b) => a[0] - b[0]).map(e => e[1]);
  let nField = 0;
  const boxFill = cells => { const X = cells.map(k => k % N), Y = cells.map(k => (k / N) | 0); return cells.length / ((Math.max(...X) - Math.min(...X) + 1) * (Math.max(...Y) - Math.min(...Y) + 1)); };
  // pass 1: tended patches in priority order; each wanted patch tries the free slots best-score first (per-seed
  // jitter) until one takes it (a slot whose shape cannot hold it stays free for the next want); the rest stay wild
  for (const [wi, use] of ringWants(L, seed).entries()) {
    const cands = slots.filter(sl => !uses[sl.id]).map(sl => [slotScore(use, sl, main, hash2(seed, 900 + wi * 37 + slots.indexOf(sl))), sl])
      .filter(([sc]) => sc > 0).sort((a, b) => b[0] - a[0]);
    let done = false;
    for (const [, sl] of cands) if (tryPatch(sl, use, hash2(seed, 1000 + slots.indexOf(sl) + wi * 53))) { uses[sl.id] = use; plan.push(sl); done = true; break; }
    if (!done) omitted.push(use);
  }
  function tryPatch(seg, use, h) {
    const pid = patches.length;
    if (use === 'field') {
      let hedged = L >= DECOR_LAYOUT.hedgeFrom && (L >= DECOR_LAYOUT.hedgeAllFrom || u01(h, 8) < 0.6);   // hedged: one convex oval
      let cells = patchCells(seg, h, free, hedged ? 0.98 : 0.95 + 0.12 * u01(h, 7), Infinity, hedged);
      if (hedged && cells.length < 20) { if (L >= DECOR_LAYOUT.hedgeAllFrom) return false; hedged = false; cells = patchCells(seg, h, free, 0.95 + 0.12 * u01(h, 7)); }
      if (cells.length < 8 || boxFill(cells) > 0.88) return false;          // never a (notched) box
      if (hedged) { const fc = fenceable(cells); if (fc && fc.length >= 16 && boxFill(fc) <= 0.9) cells = fc; else if (L >= DECOR_LAYOUT.hedgeAllFrom) return false; else hedged = false; }
      const set = new Set(cells);
      const crop = cropOrder[nField % Math.max(1, cropOrder.length)], tint = hash2(h, 9) % 4;
      for (const k of cells) ground.push({ x: k % N, y: (k / N) | 0, k: 0, t: tint, p: pid });
      if (hedged) addLoop(outlineOf(cells, set), gateTarget(cells), 'hedge', pid);
      patches.push({ kind: 'field', seg: seg.id, cells: cells.length, crop, hedged });
      const inside = inSet(set);
      if (L >= DECOR_LAYOUT.fieldPropFrom && u01(h, 10) < 0.6) {       // a scarecrow, sluice or barrow in the field
        const [cx, cy] = [cells.reduce((a, k) => a + (k % N), 0) / cells.length, cells.reduce((a, k) => a + ((k / N) | 0), 0) / cells.length];
        placeNear('fieldProp', cx + (u01(h, 11) - 0.5) * 3, cy, inside, hash2(h, 12) % 3);
      }
      if (crop) plantField(cells, inside, crop, h);
      nField++;
    } else if (use === 'pen') {
      const cells = fenceable(patchCells(seg, h, free, 1.02, 13, true)) ?? [], set = new Set(cells);   // an oval paddock
      if (cells.length < 12) return false;
      for (const k of cells) ground.push({ x: k % N, y: (k / N) | 0, k: 1, t: 0, p: pid });
      addLoop(outlineOf(cells, set), gateTarget(cells), 'pen', pid);
      patches.push({ kind: 'pen', seg: seg.id, cells: cells.length });
      const inside = inSet(set), beasts = dress.livestock ?? [], nb = L >= 14 ? 4 : L >= 10 ? 3 : 2;
      if (L >= 8) { const [px, py] = centroid(cells); placeNear('farm', px, py - 1, inside, 1); }
      const spots = cells.filter(k => inside(k % N, (k / N) | 0)).sort((a, b) => hash2(h, a) - hash2(h, b));
      for (let i = 0, n = 0; i < spots.length && n < nb; i++) {
        const x = spots[i] % N, y = (spots[i] / N) | 0;
        if (!free(x, y) || !beasts.length) continue;
        put(beasts[n % beasts.length], x, y, 'livestock', { kind: 'creature', jx: (u01(h, 40 + i) - 0.5) * 0.4, jy: (u01(h, 60 + i) - 0.5) * 0.2 }); n++;
      }
    } else if (use === 'orchard') {
      const cells = patchCells(seg, h, free, 1.05, 16);
      if (cells.length < 4) return false;
      patches.push({ kind: 'orchard', seg: seg.id, cells: cells.length });
      const trees = new Set(), list = dress.orchard ?? [];
      for (const k of [...cells].sort((a, b) => hash2(h, a) - hash2(h, b))) {
        const x = k % N, y = (k / N) | 0;
        let near = false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (trees.has((y + dy) * N + x + dx)) near = true;
        if (near || !free(x, y) || u01(h, k) > 0.8) continue;
        for (let j = 0; j < list.length; j++) {
          const id = list[(hash2(h, k + 7) + j) % list.length], pr = probe(id, 'orchard');
          if (!sky(pr)) continue;
          put(id, x, y, 'orchard', { jx: (u01(h, k + 3) - 0.5) * 0.4, jy: (u01(h, k + 5) - 0.5) * 0.3 }); trees.add(k); break;
        }
      }
      if (!trees.size) omitted.push('orchard');
    } else if (use === 'camp' || use === 'yard') {
      const cells = patchCells(seg, h, free, 1.05, use === 'camp' ? 10 : 11), set = new Set(cells);
      if (!cells.length) return false;
      for (const k of cells) ground.push({ x: k % N, y: (k / N) | 0, k: 1, t: 1, p: pid });
      patches.push({ kind: use, seg: seg.id, cells: cells.length });
      const inside = inSet(set), [cx, cy] = centroid(cells), j = (a, b) => (u01(h, a) - 0.5) * b;
      if (use === 'camp') {
        placeNear('campfire', cx + j(20, 1), cy + j(21, 1), inside);
        if (L >= DECOR_LAYOUT.tentFrom) placeNear('tent', cx - 1.5 + j(22, 1), cy - 1.5, inside);
        placeNear('hay', cx + 1.5, cy - 1 + j(23, 1), inside, hash2(h, 24));
        if (L >= DECOR_LAYOUT.wellFrom) placeNear('well', cx + 1.5, cy + 1.5, inside);
        if (L >= DECOR_LAYOUT.hiveFrom) placeNear('hive', cx - 2, cy + 1.5, inside);
        for (let i = 0; i < 1 + (band >> 1); i++) placeNear('clutter', cx + j(30 + i, 5), cy + j(40 + i, 4), inside, hash2(h, 50 + i));
      } else {
        placeNear('farm', cx, cy, inside);
        if (L >= DECOR_LAYOUT.farm2From) placeNear('farm', cx + 2.5, cy + 1.5, inside, 1);
        for (let i = 0; i < 2 + (band >> 1); i++) placeNear(i % 2 ? 'hay' : 'clutter', cx + j(30 + i, 5), cy + j(40 + i, 4), inside, hash2(h, 50 + i));
      }
    }
    return true;
  }
  // pass 2: the realm's own wild scatter in every free ring cell, thickening toward the plot edge (so the kingdom
  // melts into LIFE's wilderness beyond). Trees stand only in the outer rows: they belong to the world, not to the
  // kingdom, so they are the one thing the sky law lets reach the keep's height (never inside the claim).
  const farmed = new Uint8Array(N * N);                  // slots given a use: their leftover cells are not "wild slot"
  for (const sl of plan) if (uses[sl.id] !== 'wild') for (let y = sl.y0; y <= sl.y1; y++) for (let x = sl.x0; x <= sl.x1; x++) farmed[y * N + x] = 1;
  for (let y = g.P0; y < g.P1; y++) for (let x = g.P0; x < g.P1; x++) {
    if (!free(x, y)) continue;
    const dist = Math.max(g.A - 1 - x, x - g.B, g.A - 1 - y, y - g.B), o = clamp01((dist - 1) / Math.max(1, g.ring - 2));
    const wild = !farmed[y * N + x], h = hash2(seed ^ 0x9e3779b9, y * N + x);
    const dens = DECOR_LAYOUT.wild.base + DECOR_LAYOUT.wild.edge * o + (wild ? DECOR_LAYOUT.wild.segment : 0);
    if (u01(h, 1) >= dens) continue;
    const r = u01(h, 2), role = o >= 0.5 && r < (wild ? 0.42 : 0.28) ? 'wildTree' : r < 0.6 ? 'wildRock' : 'wildSmall';
    const list = dress[role] ?? [];
    if (!list.length) continue;
    const id = list[hash2(h, 3) % list.length], pr = probe(id, role);
    if (!fits(x, y, pr.fp[0], pr.fp[1])) continue;
    if (role !== 'wildTree' && !sky(pr)) continue;
    put(id, x, y, role, { jx: (u01(h, 4) - 0.5) * 0.5, jy: (u01(h, 5) - 0.5) * 0.3, kind: role === 'wildTree' ? 'tree' : undefined });
  }
  // the lanes: a road from each laned plot gate (meandering through the ring) to the keep's courtyard (or the
  // citadel wall), straight through the wall gates; laneEnds = the lateral shift where each leaves the plot
  const lanes = {}, laneEnds = {};
  for (const [side, l] of Object.entries(laneOf)) { lanes[side] = [...l.ring, ...l.claim]; laneEnds[side] = l.end; }
  return { sprites, edges, ground, lanes, laneEnds, patches, omitted, main };

  /** Plant a field: beds of one crop (with its sister variety now and then, like a field ripening unevenly) wherever
   *  a whole bed fits; standing crops in spaced rows with a furrow between; a few filler plants in the gaps. */
  function plantField(cells, inside, crop, h) {
    const flat = isFlatCrop(crop), [fw, fh] = probe(crop, 'crops').fp, flip = u01(h, 13) < 0.5;
    const xs = cells.map(k => k % N), ys = cells.map(k => (k / N) | 0), x0 = Math.min(...xs), y0 = Math.min(...ys);
    const order = [...cells].sort((a, b) => (((a / N) | 0) - ((b / N) | 0)) || (flip ? b - a : a - b));
    let planted = 0;
    for (const k of order) {
      const x = k % N, y = (k / N) | 0;
      if (!flat && (((y - y0) % 2) || ((x - x0) % (fw + 1)))) continue;
      if (!fits(x, y, fw, fh, inside)) continue;
      if (planted && u01(h, k + 311) < DECOR_LAYOUT.fallow) { take(x, y, fw, fh); continue; }   // a fallow bed: bare furrows
      const alt = DECOR_LAYOUT.cropPairs[crop], altOk = alt && art[realmId]?.[alt] && u01(h, k) < 0.3 && fits(x, y, ...probe(alt, 'crops').fp, inside);
      const id = altOk ? alt : crop;   // a sister bed only where its own footprint fits
      const s = probe(id, 'crops');
      if (!flat && !sky(s)) continue;
      // standing crops are hand-planted, not stamped (fix iteration 2, T3 "identical rows of dark sprites"): each bed
      // sits up to ±0.2 t off its row grid, per seed; flat beds tile edge to edge and stay on the grid
      put(id, x, y, 'crops', flat ? {} : { jx: (u01(h, k + 523) - 0.5) * 0.4, jy: (u01(h, k + 524) - 0.5) * 0.24 }); planted++;
    }
    const fill = dress.fieldFill ?? [];
    for (const k of order) {
      const x = k % N, y = (k / N) | 0;
      if (!inside(x, y) || u01(h, k + 99) > 0.3 || !fill.length) continue;
      const id = fill[hash2(h, k) % fill.length], pr = probe(id, 'fieldFill');
      if (pr.fp[0] === 1 && pr.fp[1] === 1 && sky(pr)) put(id, x, y, 'fieldFill', { jx: (u01(h, k + 7) - 0.5) * 0.3 });
    }
    if (!planted) omitted.push('crops');
  }
}
const clamp01 = v => Math.max(0, Math.min(1, v));

/** Hedge / fence sprites from the kit's own pieces (the fallback when the realm pack has no 16-piece autotile):
 *  each loop is walked row by row; two E–W neighbours pair into the kit's 2-wide `ew` rail, two N–S neighbours into
 *  a 1×2 `ns` piece where the kit has one (Stormcairn's dyke), anything else takes a `post`. Every edge tile is
 *  covered at most once. Pens use the realm's pen pieces, field hedges its edge pieces. */
export function edgeSprites(decor, { art } = {}) {
  const realm = decor.realmId, A = art ? { ...KIT_ART, [realm]: { ...KIT_ART[realm], ...art } } : KIT_ART, out = [];
  const loops = new Map();
  for (const e of decor.edges) { let l = loops.get(e.loop); if (!l) loops.set(e.loop, l = []); l.push(e); }
  for (const list of loops.values()) {
    const style = list[0].style === 'pen' ? KIT_DRESSING[realm].pen : KIT_DRESSING[realm].edge;
    const on = new Map(list.map(e => [e.x + ',' + e.y, e])), used = new Set(), free = (x, y) => on.has(x + ',' + y) && !used.has(x + ',' + y);
    for (const e of [...list].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const { x, y } = e; if (!free(x, y)) continue;
      if (style.ew && (e.mask & 2) && free(x + 1, y)) { out.push(kitSprite(realm, style.ew, x, y, 'edge', 'edge', A)); used.add(x + ',' + y); used.add(x + 1 + ',' + y); continue; }
      if (style.ns && (e.mask & 4) && free(x, y + 1)) { out.push(kitSprite(realm, style.ns, x, y, 'edge', 'edge', A)); used.add(x + ',' + y); used.add(x + ',' + (y + 1)); continue; }
      if (style.post) { out.push(kitSprite(realm, style.post, x, y, 'edge', 'edge', A)); used.add(x + ',' + y); }
    }
  }
  return out;
}

/** The plot edge as ART's 16-piece autotile (plan §5.3 plot edges; lane-art "Plot-edge autotile contract"):
 *  one 32×48 piece per edge tile, named by the arms leaving it, its cell bottom on the tile's south edge
 *  (top-left at (tx·32, ty·32 − 16)). Gates are gaps whose cheeks are end pieces. bases.js uses this when
 *  the realm pack ships `edges.pieces`, else `edgeSprites` (the kit's own fence pieces). */
export function edgeAutotileSprites(decor) {
  return decor.edges.map(e => ({ key: `edge:${EDGE_ARMS[e.mask]}`, atlas: 'edge', kind: 'edge', role: 'edge', fx: e.x, fy: e.y, fp: [1, 1],
    tx: e.x + 0.5, ty: e.y + 1, z: e.y + 1, anchor: [16, 48], scale: 1 / ART, cell: [32, 48], ink: [0, 0, 32, 48], rows: 1, clip: null, flipX: false, phase: 0 }));
}

/** Wall sprite instances (TRUE band; at MAP the walls live in the plots.webp yard layer). */
export function wallSprites(decor) { return decor.walls.map(w => wallSprite(w.tier, w.x, w.y, w.piece, w.ring)); }

/** The MAP-band LOD of the decor (plan §6.2): one mini-sprite per TRUE decor instance, at the SAME seat
 *  and depth, so each dissolves in place over d 800→1100. Walls and edges are not mini-sprites (the yard
 *  layer and GROUND's procedural edge line draw them at MAP). */
export function miniSprites(decor) {
  return decor.sprites.filter(s => s.kind !== 'fx').map(s => ({ key: s.key, atlas: s.atlas, tx: s.tx, ty: s.ty, z: s.z, anchor: s.anchor, scale: s.scale, cell: s.cell, ink: s.ink }));
}

/** Measured geometry for renderers and PACK (read-only views). */
export const DECOR_ART = Object.freeze({ game: GAME_ART, kit: KIT_ART, wallCellH: WALL_CELL_H, fire: FIRE });
export { scaleOf as decorScaleOf, footprintOf as decorFootprintOf };

// ---- paths between neighbouring kingdoms (round 2, T3 "paths joining the plot") --------------------------------
// The realm packs carry no road network (lines.json tracks are empty in all five realms), so the kingdoms make
// their own: each base walks to its nearest neighbour (and its second nearest when that one is close), leaving by
// the gate that faces it along a gentle curve. A link is dropped rather than drawn through a third kingdom.
// Pure and deterministic (bases.js draws it; the shader stops a path at water, like a ford).
export const PATHS = Object.freeze({ maxDeeds: 2.2, secondDeeds: 1.35, stepTiles: 4, clearTiles: 1, loneDeeds: 4.5 });
const SIDE_N = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };
/** basePaths(bases) → { segments, sides, links }: the whole network at once (tests, tools). bases.js runs basePathsJob
 *  instead, sliced under its per-frame budget (P0 fix pass: one whole-realm build is 65–290 ms, over D-167's 50 ms bar). */
export function basePaths(bases, opts = {}) {
  const job = basePathsJob(bases, opts);
  for (;;) { const r = job.next(); if (r.done) return r.value; }
}
/** The same network as a generator: it yields after every small unit of work (64 kingdoms' plot boxes, the deed grid,
 *  one kingdom's neighbour search, the pair sort, one link attempt) and returns { segments, sides, links }, identical to
 *  basePaths however a caller slices it (it holds no clock; `bases` must not change while it runs — bases.js starts a
 *  new job on setBases). */
export function* basePathsJob(bases, opts = {}) {
  const O = { ...PATHS, ...opts };
  const P = new Array(bases.length);
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i], o = plotOffset(b.x, b.y, b.level), r = plotRule(b.level);
    P[i] = { b, cx: b.x + (C + o.dx) / TILES, cy: b.y + (C + o.dy) / TILES, half: r.plotTiles / 2 / TILES, seed: seedOf(b.id), ring: r.ring };
    if ((i & 63) === 63) yield;
  }
  const grid = new Map(), cell = p => `${Math.floor(p.cx)},${Math.floor(p.cy)}`;
  P.forEach((p, i) => { const k = cell(p); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i); });
  yield;
  const near = (p, R) => { const out = [], r = Math.ceil(R);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) for (const j of grid.get(`${Math.floor(p.cx) + dx},${Math.floor(p.cy) + dy}`) ?? []) out.push(j);
    return out; };
  const pairs = new Map();
  for (let i = 0; i < P.length; i++) {
    const p = P[i], c = near(p, O.maxDeeds).filter(j => j !== i).map(j => [Math.hypot(P[j].cx - p.cx, P[j].cy - p.cy), j]).filter(([d]) => d <= O.maxDeeds).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    c.slice(0, 2).forEach(([d, j], n) => { if (n === 0 || d <= O.secondDeeds) pairs.set(i < j ? `${i}|${j}` : `${j}|${i}`, [Math.min(i, j), Math.max(i, j)]); });
    yield;
  }
  const inBox = (q, x, y, m) => Math.abs(x - q.cx) < q.half + m && Math.abs(y - q.cy) < q.half + m;
  const sidesOf = (a, b) => { const dx = b.cx - a.cx, dy = b.cy - a.cy, h = dx > 0 ? 'E' : 'W', v = dy > 0 ? 'S' : 'N';
    return Math.abs(dx) >= Math.abs(dy) ? [h, v] : [v, h]; };
  // a path leaves where the side's (meandering) lane meets the plot edge: its centre line is 49 + laneMeander.end
  const exit = (q, s) => { const sh = laneMeander(q.seed, s, q.ring).end / TILES, ns = s === 'N' || s === 'S';
    return [q.cx + SIDE_N[s][0] * q.half + (ns ? sh : 0), q.cy + SIDE_N[s][1] * q.half + (ns ? 0 : sh)]; };
  const segments = [], links = [], sides = new Map(), m = O.clearTiles / TILES;
  const tryLink = (i, j) => {
    const a = P[i], b = P[j], h = hash2(i * 7919 + j, 4241) / 4294967296, others = near({ cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2 }, O.maxDeeds).filter(k => k !== i && k !== j);
    let best = null;
    for (const sa of sidesOf(a, b)) for (const sb of sidesOf(b, a)) {
      if (best) break;
      const e1 = exit(a, sa), e2 = exit(b, sb), dist = Math.hypot(e2[0] - e1[0], e2[1] - e1[1]);
      if (dist < 2 / TILES) continue;
      const k = Math.max(3 / TILES, 0.4 * dist), px = -(e2[1] - e1[1]) / dist, py = (e2[0] - e1[0]) / dist, bow = (h - 0.5) * 0.3 * dist;
      const c1 = [e1[0] + SIDE_N[sa][0] * k + px * bow, e1[1] + SIDE_N[sa][1] * k + py * bow], c2 = [e2[0] + SIDE_N[sb][0] * k + px * bow, e2[1] + SIDE_N[sb][1] * k + py * bow];
      const n = Math.max(4, Math.ceil((dist * TILES) / O.stepTiles)), pts = [];
      let ok = true;
      for (let s = 0; s <= n && ok; s++) {
        const t = s / n, u = 1 - t, x = u * u * u * e1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e2[0], y = u * u * u * e1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e2[1];
        pts.push([x, y]);
        if (s > 0 && s < n && (inBox(a, x, y, -1e-9) || inBox(b, x, y, -1e-9) || others.some(o => inBox(P[o], x, y, m)))) ok = false;
      }
      if (ok) best = { sa, sb, pts };
    }
    if (!best) return false;
    for (let s = 0; s + 1 < best.pts.length; s++) segments.push({ a: best.pts[s], b: best.pts[s + 1], seed: h });
    links.push({ a: String(a.b.id), b: String(b.b.id), sa: best.sa, sb: best.sb, pts: best.pts, seed: h });
    for (const [q, sd] of [[a, best.sa], [b, best.sb]]) { const id = String(q.b.id); let st = sides.get(id); if (!st) sides.set(id, st = new Set()); st.add(sd); }
    return true;
  };
  const order = [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  yield;
  for (const [, [i, j]] of order) { tryLink(i, j); yield; }
  // fix iteration 2: a kingdom whose pairs all failed (a third kingdom in the way) or had none within maxDeeds walks on
  // to its next-nearest neighbours up to loneDeeds, so almost no kingdom is left without a road (lanes need a path)
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (sides.get(String(p.b.id))?.size) continue;
    const c = near(p, O.loneDeeds).filter(j => j !== i).map(j => [Math.hypot(P[j].cx - p.cx, P[j].cy - p.cy), j]).filter(([d]) => d <= O.loneDeeds).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, j] of c.slice(0, 6)) { const ok = !pairs.has(i < j ? `${i}|${j}` : `${j}|${i}`) && tryLink(Math.min(i, j), Math.max(i, j)); yield; if (ok) break; }
  }
  return { segments, sides, links };
}

// ---- paths over terrain (fix iteration 1: "roads run into the sea and across lava, ending at the shore without a
// ford or bridge"). Wet tiles (DEEP, SEA, WATER — Cinderfall's WATER is its lava) are impassable except at a designed
// crossing: a short run is bridged with the realm kit's bridge pieces on a straight axis through the run, bank to
// bank, the path turning onto that axis first; a realm without a bridge piece fords a shallow run (stepping stones,
// drawn by the path shader); anything wider drops the link (the kingdoms' own gate lanes stay). Pure: the caller
// passes clsAt(tileX, tileY) → CLASS id (bases.js wraps classify.classAt over GROUND's fields).
export const PATH_TERRAIN = Object.freeze({ step: 0.9, maxBridge: 10, maxFord: 5, approach: 1.5, probe: 0.5 });
const WET_CLASS = c => c <= 2;
/** Settle one link (basePaths().links[i].pts, deed units) over terrain → null (dropped) or { segments: [{a, b, ford, bridge}],
 *  crossings: [{ axis: 'ew'|'ns', kind: 'bridge'|'ford', from: [x, y], to: [x, y] }] } (crossing ends in tiles, on the
 *  axis line, just past the wet run on either bank). */
export function settlePath(pts, clsAt, { bridge = true } = {}) {
  const T = TILES, O = PATH_TERRAIN, wetAt = (x, y) => WET_CLASS(clsAt(Math.floor(x), Math.floor(y)));
  const P = pts.map(p => [p[0] * T, p[1] * T]), S = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const [ax, ay] = P[i], [bx, by] = P[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / O.step));
    for (let t = i ? 1 : 0; t <= n; t++) S.push([ax + ((bx - ax) * t) / n, ay + ((by - ay) * t) / n, t === n ? i + 1 : i]);
  }
  // every span over water is flagged here (P0 fix: the path shader reads no terrain per pixel, it draws a ford span's
  // wet middle as stepping stones and leaves a bridge span to the kit bridge sprite)
  const wet = S.map(([x, y]) => wetAt(x, y)), toSegs = (list, spans) => {
    const out = [];
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue;
      out.push({ a: [a[0] / T, a[1] / T], b: [b[0] / T, b[1] / T], ford: spans.get(i) === 'ford', bridge: spans.get(i) === 'bridge' });
    }
    return out;
  };
  if (!wet.includes(true)) return { segments: toSegs(P, new Map()), crossings: [] };
  if (wet[0] || wet[wet.length - 1]) return null;
  const dryLine = (p, q) => { const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / O.probe));
    for (let t = 0; t <= n; t++) if (wetAt(p[0] + ((q[0] - p[0]) * t) / n, p[1] + ((q[1] - p[1]) * t) / n)) return false; return true; };
  const maxSpan = bridge ? O.maxBridge : O.maxFord, res = [P[0]], spans = new Map(), crossings = [];
  let k = 0, last = 0;
  while (k < S.length) {
    if (!wet[k]) { k++; continue; }
    let e = k; while (e < S.length && wet[e]) e++;
    const a = S[k - 1], b = S[e], m = S[(k + e - 1) >> 1], ew = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const sg = Math.sign(ew ? b[0] - a[0] : b[1] - a[1]) || 1, at = t => (ew ? [m[0] + t * sg, m[1]] : [m[0], m[1] + t * sg]);
    let lo = 0, hi = 0;
    while (wetAt(...at(lo - O.probe))) { lo -= O.probe; if (hi - lo > maxSpan) return null; }
    while (wetAt(...at(hi + O.probe))) { hi += O.probe; if (hi - lo > maxSpan) return null; }
    const A = at(lo - 1), B = at(hi + 1), A0 = at(lo - 1 - O.approach), B0 = at(hi + 1 + O.approach);
    if (!dryLine(a, A0) || !dryLine(A0, A) || !dryLine(B, B0) || !dryLine(B0, b)) return null;
    for (let v = last + 1; v <= a[2]; v++) res.push(P[v]);
    res.push(a, A0, A); spans.set(res.length - 1, bridge ? 'bridge' : 'ford');   // the A→B segment
    res.push(B, B0, b);
    crossings.push({ axis: ew ? 'ew' : 'ns', kind: bridge ? 'bridge' : 'ford', from: at(lo - O.probe), to: at(hi + O.probe) });
    last = b[2]; k = e;
  }
  for (let v = last + 1; v < P.length; v++) res.push(P[v]);
  return { segments: toSegs(res, spans), crossings };
}
/** The realm kit's bridge piece for an axis (a flat kit sprite probe: key, footprint, anchor, cell), or null. */
export function bridgePiece(realmId, axis) { const id = KIT_DRESSING[realmId]?.bridge?.[axis]; return id ? kitSprite(realmId, id, 0, 0, 'flat', 'bridge') : null; }
/** Bridge sprite seats for a crossing (kit pieces along the axis, centred on the wet span, each seated like every
 *  kit prop: tx on its footprint centre, ty on its south edge), in world tiles. */
export function bridgeSeats(cr, piece) {
  const [fw, fh] = piece.fp, ew = cr.axis === 'ew', len = Math.abs(ew ? cr.to[0] - cr.from[0] : cr.to[1] - cr.from[1]) + 1;
  // pieces butt ink to ink (one art px of overlap), so no lava or water shows between the planks
  const step = ew ? Math.min(fw, (piece.ink[2] - piece.ink[0] - 1) * piece.scale) : Math.min(fh, (piece.ink[3] - piece.ink[1] - 1) * piece.scale), n = Math.max(1, Math.ceil(len / step)), mid = [(cr.from[0] + cr.to[0]) / 2, (cr.from[1] + cr.to[1]) / 2], out = [];
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) / 2) * step;
    if (ew) { const x0 = mid[0] + o - fw / 2, y0 = Math.floor(mid[1] - fh / 2 + 0.5); out.push({ tx: x0 + fw / 2, ty: y0 + fh, z: y0 + fh }); }
    else { const x0 = Math.floor(mid[0] - fw / 2 + 0.5), y0 = mid[1] + o - fh / 2; out.push({ tx: x0 + fw / 2, ty: y0 + fh, z: y0 + fh }); }
  }
  return out;
}
