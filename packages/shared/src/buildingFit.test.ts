/**
 * THE SIZE CONTRACT for structures, pinned against the published world fits.
 *
 * The rule, its two clauses and the reason each clause has the owner it has are
 * documented once, in `BUILDING_FIT` in constants.ts. This file is only its
 * enforcement: ONE law, applied to EVERY family that can stand on a base.
 *
 *   GROUND   inkWidth  ≤ footprintWidth × tile × BUILDING_FIT.maxPlotOverhang
 *   SKY      inkHeight <  keepInkHeight(sameLevel)     (nothing REACHES the Keep)
 *            inkArea   <  keepInkArea(sameLevel)       (nothing OUT-MASSES it)
 *
 * The sky clause runs from each family's `requiresKeepLevel` upward (KEEP_GATE
 * below), because a family can only be compared against a Keep it can actually
 * stand beside — see BUILDING_FIT for why that distinction is load-bearing.
 *
 * WHAT CHANGED, and why this file was rewritten rather than extended (owner
 * 2026-08-30: "stabilize buildings and defences size … now it's total mess in
 * sizing"). The previous version pinned ONE clause — Keep dominance — over ONE
 * scope — the seven DEFENCE families — and explicitly named the Clan Hall and
 * the Hero Altar as out of scope because "fixing them is a look decision on art
 * nobody complained about". The owner has since complained about the whole
 * board, so the scope is now every family and the clauses are the ones a
 * projection actually has. Under the wider net the Clan Hall turned out to be
 * the largest breach on the base — the tallest building on every base from Keep
 * level 5 up, in both the pack it shipped on and the pack that replaced it
 * mid-pass (see WARE_WORLD_PRESENTATION.clanhall).
 *
 * Why the law is decidable here at all: a building's rendered size is
 * `publishedFit × authoredInk`, and every renderer applies the same fit — the
 * @2x web world, the @1x deed renderer and the battle scene differ only by
 * constant factors that cancel out of a comparison BETWEEN two buildings, and a
 * building carries NO battle multiplier at all. So the whole contract is
 * decidable from the constants plus one table of art measurements.
 *
 * INK is the opaque bounding box of each family's live sprite, in the authored
 * 32-px-per-tile game space, MEASURED OFF LIVE SPRITES IN BOTH RUNNING SCENES
 * (the alpha channel of the live texture, not the cell, which is mostly
 * padding), at Keep levels 1/6/11/16/20 — the first level of each art band plus
 * the top, which is where the Keep is smallest against a family that has
 * already grown and therefore the only place the rule can break first. The
 * worst frame of each family at each level is the one recorded.
 *
 * ⚠ THESE ARE ART FACTS, MEASURED 2026-08-30 AGAINST `art/game-v4` AS PACKED
 * THAT DAY. If a pack is re-authored they must be RE-MEASURED and every fit
 * re-derived from them — this table cannot detect that on its own, which is
 * exactly the mistake WARE_WORLD_PRESENTATION.dragonnest exists to warn about.
 * It happened again during this very pass: the pack was re-delivered mid-lane
 * and every figure here moved (the Cannon alone lost 44% of its drawn area), so
 * a first, fully-derived set of fits had to be thrown away and re-solved. If
 * you are reading this after an art delivery, assume the table is stale.
 */
import { describe, expect, it } from 'vitest';
import { ART_V2, BUILDING_FIT, WARE_WORLD_PRESENTATION } from './constants';

const TILE = 32; // authored game px per tile; ink below is in that same space

/**
 * Opaque ink (w, h) in authored px, and the logical footprint in tiles, by Keep
 * level.
 *
 * RE-MEASURED 2026-08-30 FROM AN OVERLAY BUILD, replacing a first table whose
 * WIDTHS were right and whose HEIGHTS were wrong — it read the Keep at L20 as
 * 117x94 when the shipped castle is 117x123. The cause was a rasterize without
 * `SHARDKEEP_GAME_V4_OVERLAY=1`, which packs the SUPERSEDED art and still exits
 * 0. A too-short Keep makes every other family look too tall against the sky
 * clause, which is how this file came to demand shrinks for two buildings
 * (barracks, magetower) that were inside the law all along.
 *
 * Every row is now taken from `meta.currentArtAliases['bld_<family>_l<N>']`
 * resolved into the packed atlas, so the level mapping is the game's own rather
 * than an assumed tier split. Regenerate the same way; do not hand-edit a cell.
 */
const INK: Record<string, {
  fp: readonly [number, number];
  byLevel: Readonly<Record<number, readonly [number, number]>>;
}> = {
  keep: { fp: [2, 2], byLevel: { 1: [81, 86], 6: [90, 87], 11: [97, 100], 16: [109, 115], 20: [117, 123] } },
  goldforge: { fp: [2, 2], byLevel: { 1: [52, 46], 6: [62, 56], 11: [74, 67], 16: [84, 78], 20: [93, 86] } },
  vault: { fp: [1, 1], byLevel: { 1: [55, 48], 6: [56, 53], 11: [62, 56], 16: [62, 57], 20: [62, 57] } },
  barracks: { fp: [2, 1], byLevel: { 1: [75, 60], 6: [82, 61], 11: [88, 63], 16: [92, 66], 20: [92, 66] } },
  forge: { fp: [1, 1], byLevel: { 1: [51, 52], 6: [57, 60], 11: [62, 63], 16: [64, 73], 20: [64, 73] } },
  camp: { fp: [2, 2], byLevel: { 1: [43, 28], 6: [47, 34], 11: [51, 43], 16: [56, 45], 20: [56, 45] } },
  archertower: { fp: [1, 1], byLevel: { 1: [38, 56], 6: [42, 63], 11: [46, 68], 16: [50, 78], 20: [50, 78] } },
  electrictower: { fp: [1, 1], byLevel: { 1: [44, 66], 6: [44, 73], 11: [44, 79], 16: [44, 87], 20: [44, 87] } },
  magetower: { fp: [1, 1], byLevel: { 1: [27, 55], 6: [29, 62], 11: [31, 69], 16: [31, 75], 20: [31, 75] } },
  lasertower: { fp: [1, 1], byLevel: { 1: [58, 62], 6: [58, 74], 11: [58, 87], 16: [58, 87], 20: [58, 87] } },
  mine: { fp: [1, 1], byLevel: { 1: [66, 56], 6: [64, 61], 11: [67, 69], 16: [67, 74], 20: [67, 74] } },
  clanhall: { fp: [2, 2], byLevel: { 1: [54, 56], 6: [66, 88], 11: [80, 88], 16: [94, 88], 20: [94, 88] } },
  dragonnest: { fp: [2, 2], byLevel: { 1: [69, 46], 6: [79, 61], 11: [87, 73], 16: [99, 84], 20: [99, 84] } },
  airdefence: { fp: [2, 2], byLevel: { 1: [73, 41], 6: [80, 48], 11: [87, 54], 16: [95, 61], 20: [95, 61] } },
  spiketrap: { fp: [1, 1], byLevel: { 1: [22, 15], 6: [25, 15], 11: [27, 17], 16: [27, 17], 20: [27, 17] } },
  powdermine: { fp: [1, 1], byLevel: { 1: [20, 18], 6: [21, 21], 11: [27, 23], 16: [23, 23], 20: [23, 23] } },
  pitfall: { fp: [1, 1], byLevel: { 1: [23, 17], 6: [27, 17], 11: [27, 17], 16: [29, 18], 20: [29, 18] } },
  airmine: { fp: [1, 1], byLevel: { 1: [13, 20], 6: [14, 21], 11: [15, 22], 16: [14, 23], 20: [14, 23] } },
  // The N-S wall piece: the tall edge-on segment, the worst of the connect set.
  // Re-measured and UNCHANGED from the first table — walls were the one family
  // the bad capture got right, because a segment is exactly one tile wide by
  // construction and so cannot drift with the art.
  wall: { fp: [1, 1], byLevel: { 1: [32, 40], 6: [32, 40], 11: [32, 44], 16: [32, 50], 20: [32, 56] } },
  cannon: { fp: [1, 1], byLevel: { 1: [61, 80], 6: [66, 87], 11: [71, 94], 16: [75, 100], 20: [75, 100] } },
  mortar: { fp: [2, 2], byLevel: { 1: [67, 52], 6: [67, 57], 11: [67, 62], 16: [67, 62], 20: [67, 62] } },
};

/**
 * `BUILD_COSTS.requiresKeepLevel` — the first Keep a family can stand beside.
 * The sky clause runs from here, not from level 1. Duplicated deliberately as
 * the SKY CLAUSE'S OWN premise rather than imported: if a gate moves, this file
 * must be re-solved, and a silent re-import would let the fits go stale while
 * still passing. `constants.test.ts` owns the gates themselves.
 */
const KEEP_GATE: Readonly<Record<string, number>> = {
  cannon: 1, archertower: 1, mortar: 3, airdefence: 7, barracks: 1, wall: 1,
  spiketrap: 1, powdermine: 4, pitfall: 6, airmine: 8, mine: 1, vault: 1,
  camp: 1, forge: 2, electrictower: 8, magetower: 10, lasertower: 12,
  dragonnest: 14, goldforge: 3, clanhall: 5, keep: 1,
};

const LEVELS = [1, 6, 11, 16, 20] as const;

/** Published world fit for a family, whichever pack it is authored in. */
function fitOf(unit: string): number {
  const v2: Record<string, number> = ART_V2.buildingSourceScale;
  const ware: Record<string, { sourceScale: number }> = WARE_WORLD_PRESENTATION;
  const fit = v2[unit] ?? ware[unit]?.sourceScale;
  if (fit === undefined) throw new Error(`${unit} publishes no world fit`);
  return fit;
}

/** Drawn body of a family at a level, in authored px (fit × ink). */
function body(unit: string, level: number): { w: number; h: number } {
  const [w, h] = INK[unit]!.byLevel[level]!;
  const fit = fitOf(unit);
  return { w: w * fit, h: h * fit };
}

describe('the size contract — structures', () => {
  /**
   * GROUND. Width is the axis a plot owns, so this is the clause with teeth: it
   * is what "this defences and building need to fit into its tiles" means. It is
   * the clause the owner's own words state, and against the pack that prompted
   * the report it was the binding one for four families at once (the Cannon at
   * 1.289 of its plot, the Vault at 1.308, the Forge at 1.300, the Laser Tower
   * at 1.219). The game-v4 redraw brought all four inside it on art alone,
   * which is the outcome a law is supposed to produce — but it stays pinned,
   * because the next pack has no memory.
   */
  it('draws no structure wider than its own plot, times one allowance', () => {
    for (const [unit, { fp }] of Object.entries(INK)) {
      for (const level of LEVELS) {
        const ratio = body(unit, level).w / (fp[0] * TILE);
        expect(ratio, `${unit} L${level} width / plot`)
          .toBeLessThanOrEqual(BUILDING_FIT.maxPlotOverhang);
      }
    }
  });

  /**
   * The allowance is not a taste call — it is the KEEP'S OWN overhang, so the
   * Keep is not an exception to the ground clause but the definition of it. If
   * this fails, either the Keep art changed or someone invented a new number:
   * re-derive `maxPlotOverhang` FROM the Keep, do not raise it to fit a family.
   */
  it('sets the allowance at the Keep’s own overhang', () => {
    const keep = body('keep', 20);
    const own = keep.w / (INK.keep!.fp[0] * TILE);
    expect(own).toBeGreaterThan(BUILDING_FIT.maxPlotOverhang - 0.02);
    expect(own).toBeLessThanOrEqual(BUILDING_FIT.maxPlotOverhang);
  });

  /**
   * SKY, clause 1 — nothing REACHES the Keep. Height is elevation and no plot
   * owns elevation; the Keep does (owner 2026-08-30: "The Keep is the biggest
   * thing on a base; nothing reaches it"). Compared at EQUAL level, which is
   * the harshest reading and the honest one: a defender's Keep level and their
   * building levels move together.
   */
  it('lets nothing stand as tall as the Keep at the same level', () => {
    for (const unit of Object.keys(INK)) {
      if (unit === 'keep') continue;
      for (const level of LEVELS) {
        if (level < KEEP_GATE[unit]!) continue;
        expect(body(unit, level).h, `${unit} L${level} height vs keep`)
          .toBeLessThan(body('keep', level).h);
      }
    }
  });

  /**
   * SKY, clause 2 — nothing OUT-MASSES the Keep. Height alone is not "biggest":
   * the Mortar never out-grew the Keep in height, and the Barracks never does
   * either, but both are wide. Mass is the axis-free reading of the owner's
   * word, and it is what keeps a squat, sprawling family honest.
   */
  it('lets nothing carry more drawn mass than the Keep at the same level', () => {
    for (const unit of Object.keys(INK)) {
      if (unit === 'keep') continue;
      for (const level of LEVELS) {
        if (level < KEEP_GATE[unit]!) continue;
        const b = body(unit, level);
        const k = body('keep', level);
        expect(b.w * b.h, `${unit} L${level} mass vs keep`).toBeLessThan(k.w * k.h);
      }
    }
  });

  /**
   * The ORDER a footprint is supposed to buy. This is the pair the owner named
   * ("look at the cannon how big and ugly it is, and mortar too"): the 1×1
   * Cannon used to draw more mass than the 2×2 Mortar standing next to it, so
   * the plot the player pays for said nothing about what they get. Called out
   * by unit so a future fit edit that happens to satisfy the loops above still
   * fails loudly here if it puts the small gun back over the big one.
   */
  it('draws the 2×2 Mortar decisively larger than the 1×1 Cannon', () => {
    for (const level of LEVELS) {
      if (level < KEEP_GATE.mortar!) continue; // a Mortar needs Keep 3
      const c = body('cannon', level);
      const m = body('mortar', level);
      expect(m.w * m.h, `mortar/cannon mass at L${level}`)
        .toBeGreaterThan(1.4 * c.w * c.h);
      expect(m.w, `mortar/cannon width at L${level}`).toBeGreaterThan(c.w);
    }
  });

  /**
   * The wall is the one family whose fit may never move: `sourceScale: 1` is
   * what makes a segment's CELL exactly one tile, which is what makes a run
   * tile flush. Verified flush at exactly 1.000 by the world lane; a fit edit
   * here would open seams along every wall in the game. (Its INK is inset
   * inside that cell by design — flushness is a property of the cell, not of
   * the opaque box, which is why the ground clause reads 0.66 for a wall.)
   */
  it('never rescales the wall, whose cell IS the tile', () => {
    expect(WARE_WORLD_PRESENTATION.wall.sourceScale).toBe(1);
  });

  /**
   * Every family that can stand on a base must PUBLISH a fit. The original bug
   * was not a wrong number, it was a missing one: `v2BldSeat` had nowhere to
   * read a fit from, so it drew the raw pack conversion and the two v2 towers
   * were the only buildings nobody had ever sized against the Keep.
   *
   * ⚠ TWO STRUCTURES STILL PUBLISH NO FIT AND ARE THEREFORE ABSENT FROM `INK`
   * ABOVE: the Hero Altar and the Siege Tools. They are eager legacy masters
   * (`bld_heroaltar`, `bld_siegestool`), not WARE clips, so their only scale
   * lever is `sprites[].sourceScale` in the packed atlas metadata — which the
   * rasterizer writes ONLY for WARE current-art aliases. Measured on the same
   * pass, the Hero Altar draws 108×138 world px and the Siege Tools 120×114,
   * against a Keep that is 141×109 at level 6 — so both out-TOP every Keep in
   * the game while neither out-masses one. Both are real breaches of the sky
   * clause and neither can be fixed from constants.ts: it is a change to the
   * asset pipeline. Do NOT "fix" this test by adding them to INK with an
   * invented fit — the fit would not reach the renderer.
   */
  it('publishes a world fit for every family this contract governs', () => {
    for (const unit of Object.keys(INK)) expect(() => fitOf(unit)).not.toThrow();
    expect(Object.keys(ART_V2.buildingSourceScale).sort())
      .toEqual([...ART_V2.buildings].sort());
  });
});
